import type {AnyMessageFrom, MessageConsumer, MessageRepository, StreamDefinition} from './index.js';
import type {OffsetRepository} from '@deltic/offset-tracking';
import {type TransactionManager} from '@deltic/transaction-manager';

export interface IdentifierResolver<Stream extends StreamDefinition> {
    (message: AnyMessageFrom<Stream>): string;
}

export type OffsetResolver = <Stream extends StreamDefinition>(message: AnyMessageFrom<Stream>) => number;

export interface ExactlyOnceMessageConsumerOptions<Stream extends StreamDefinition> {
    resolveIdentifier?: IdentifierResolver<Stream>;
    resolveOffset?: OffsetResolver;
    /**
     * Set when exactly-once consumption is introduced for a consumer that already processed messages:
     * a stream without a stored offset starts at the message that arrives instead of replaying its history.
     */
    introducedLater?: boolean;
}

/**
 * Consumes the messages of a stream once and in order: redeliveries are skipped, and a gap in front of a
 * message is replayed from the message repository first.
 */
export class ExactlyOnceMessageConsumerDecorator<Stream extends StreamDefinition> implements MessageConsumer<Stream> {
    private readonly resolveIdentifier: IdentifierResolver<Stream>;
    private readonly resolveOffset: OffsetResolver;
    private readonly initialOffset: number | undefined;

    constructor(
        private readonly offsets: OffsetRepository,
        private readonly consumer: MessageConsumer<Stream>,
        private readonly messages: MessageRepository<Stream>,
        private readonly transactions: TransactionManager,
        options: ExactlyOnceMessageConsumerOptions<Stream> = {},
    ) {
        this.resolveIdentifier =
            options.resolveIdentifier ?? (message => message.headers['aggregate_root_id']?.toString() ?? 'unknown');
        this.resolveOffset = options.resolveOffset ?? (message => Number(message.headers['aggregate_root_version'] ?? 0));
        this.initialOffset = options.introducedLater === true ? undefined : 0;
    }

    async consume(message: AnyMessageFrom<Stream>): Promise<void> {
        const messageId = message.headers.aggregate_root_id;

        if (messageId === undefined) {
            throw new Error('Encountered message without aggregate_root_id header');
        }

        const identifier = this.resolveIdentifier(message);
        const storedOffset = (await this.offsets.retrieve(identifier)) ?? this.initialOffset;

        // Introduced later: an untracked stream starts at this message
        if (storedOffset === undefined) {
            return this.forwardMessage(message);
        }

        const currentOffset = this.resolveOffset(message);

        // Prevent double delivery
        if (storedOffset >= currentOffset) {
            return;
        }

        if (storedOffset < currentOffset - 1) {
            await this.replayBetween(messageId, storedOffset, currentOffset);
        }

        return this.forwardMessage(message);
    }

    private async forwardMessage(message: AnyMessageFrom<Stream>): Promise<void> {
        const offset = this.resolveOffset(message);
        const identifier = this.resolveIdentifier(message);

        await this.transactions.runInTransaction(async () => {
            await this.consumer.consume(message);
            await this.offsets.store(identifier, offset);
        });
    }

    private async replayBetween(id: Stream['aggregateRootId'], after: number, before: number): Promise<void> {
        const messages = this.messages.retrieveBetweenVersions(id, after, before);

        for await (const message of messages) {
            await this.forwardMessage(message);
        }
    }
}
