import type {
    AdditionalMessageHeaders,
    AnyMessageFrom,
    AnyMessageTypeFromStream,
    MessageDecorator,
    MessageDispatcher,
    MessageRepository,
    MessagesFrom,
    StreamDefinition,
} from '@deltic/messaging';
import {type Clock, GlobalClock} from '@deltic/clock';
import type {TransactionManager} from '@deltic/transaction-manager';

export interface AggregateStream<Stream extends AggregateStream<Stream>> extends StreamDefinition {
    aggregateRoot: AggregateRoot<Stream>;
}

export interface AggregateRoot<Stream extends AggregateStream<Stream>> {
    releaseEvents(): MessagesFrom<Stream>;
    peekEvents(): MessagesFrom<Stream>;
    hasUnreleasedEvents(): boolean;
    aggregateRootVersion(): number;
    readonly aggregateRootId: Stream['aggregateRootId'];
}

export interface AggregateRootFactory<Stream extends AggregateStream<Stream>> {
    reconstituteFromEvents(
        id: Stream['aggregateRootId'],
        events: AsyncGenerator<AnyMessageFrom<Stream>>,
    ): Promise<Stream['aggregateRoot']>;
}

export interface AggregateRepository<Stream extends AggregateStream<Stream>> {
    retrieve(id: Stream['aggregateRootId']): Promise<Stream['aggregateRoot']>;
    retrieveAtVersion(id: Stream['aggregateRootId'], version: number): Promise<Stream['aggregateRoot']>;
    persist(aggregateRoot: Stream['aggregateRoot']): Promise<void>;
}

export class EventSourcedAggregateRepository<
    Stream extends AggregateStream<Stream>,
> implements AggregateRepository<Stream> {
    constructor(
        protected readonly factory: AggregateRootFactory<Stream>,
        protected readonly messageRepository: MessageRepository<Stream>,
        protected readonly messageDispatcher: MessageDispatcher<Stream> | undefined = undefined,
        protected readonly messageDecorator: MessageDecorator<Stream> = {
            decorate: messages => messages,
        },
        protected readonly transactionManager: TransactionManager,
    ) {}

    async retrieve(id: Stream['aggregateRootId']): Promise<Stream['aggregateRoot']> {
        return this.factory.reconstituteFromEvents(id, this.messageRepository.retrieveAllForAggregate(id));
    }

    async retrieveAtVersion(id: Stream['aggregateRootId'], version: number): Promise<Stream['aggregateRoot']> {
        return this.factory.reconstituteFromEvents(id, this.messageRepository.retrieveAllUntilVersion(id, version + 1));
    }

    /**
     * The aggregate keeps its events until they are stored and the transaction this repository
     * opened has committed, so a rejected persist() can be retried with the same aggregate.
     */
    async persist(aggregateRoot: Stream['aggregateRoot']): Promise<void> {
        if (!aggregateRoot.hasUnreleasedEvents()) {
            return;
        }

        const alreadyInTransaction = this.transactionManager.inTransaction();

        if (!alreadyInTransaction) {
            await this.transactionManager.begin();
        }

        try {
            await this.storeRecordedEvents(aggregateRoot);
        } catch (e) {
            if (!alreadyInTransaction) {
                await this.transactionManager.rollback();
            }
            throw e;
        }

        if (!alreadyInTransaction) {
            await this.transactionManager.commit();
        }

        aggregateRoot.releaseEvents();
    }

    /**
     * Writes and dispatches the recorded events, leaving them on the aggregate.
     */
    protected async storeRecordedEvents(aggregateRoot: Stream['aggregateRoot']): Promise<void> {
        const messages = this.messageDecorator.decorate(aggregateRoot.peekEvents());

        await this.messageRepository.persist(aggregateRoot.aggregateRootId, messages);
        await this.messageDispatcher?.send(...messages);
    }
}

export type AggregateRootOptions = {
    clock?: Clock;
};

export abstract class AggregateRootBehavior<Stream extends AggregateStream<Stream>> implements AggregateRoot<Stream> {
    protected readonly _clock: Clock;
    readonly aggregateRootId: Stream['aggregateRootId'];
    protected recordedMessages: MessagesFrom<Stream> = [];
    protected aggregateRootVersionNumber = 0;

    constructor(aggregateRootId: Stream['aggregateRootId'], options: AggregateRootOptions = {}) {
        this.aggregateRootId = aggregateRootId;
        this.recordThat = this.recordThat.bind(this);
        this._clock = options.clock ?? GlobalClock;
    }

    protected recordThat<T extends AnyMessageTypeFromStream<Stream>>(
        type: T,
        payload: Stream['messages'][T],
        headers: AdditionalMessageHeaders = {},
    ): void {
        const timeOfRecording = this._clock.date();
        const message: AnyMessageFrom<Stream> = {
            payload,
            type,
            headers: {
                ...headers,
                aggregate_root_id: this.aggregateRootId,
                aggregate_root_version: this.aggregateRootVersionNumber + 1,
                time_of_recording: timeOfRecording.toISOString(),
                time_of_recording_ms: timeOfRecording.getTime(),
            },
        };
        this.recordedMessages.push(message);
        this.apply(message);
    }

    protected abstract apply(message: AnyMessageFrom<Stream>): void;

    protected async applyAll(messages: AsyncGenerator<AnyMessageFrom<Stream>>): Promise<this> {
        for await (const m of messages) {
            this.apply(m);
        }

        return this;
    }

    aggregateRootVersion(): number {
        return this.aggregateRootVersionNumber;
    }

    releaseEvents(): MessagesFrom<Stream> {
        const events = this.recordedMessages;
        this.recordedMessages = [];
        return events;
    }

    peekEvents(): MessagesFrom<Stream> {
        return structuredClone(this.recordedMessages);
    }

    hasUnreleasedEvents(): boolean {
        return this.recordedMessages.length !== 0;
    }
}
