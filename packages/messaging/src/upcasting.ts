import type {
    AggregateIdWithStreamOffset,
    AnyMessageFrom,
    IdPaginationOptions,
    Message,
    MessageConsumer,
    MessageDecorator,
    MessageRepository,
    MessagesFrom,
    StreamDefinition,
} from './index.js';
import {messageWithHeader} from './helpers.js';
import type {OutboxRepository} from './outbox.js';

interface VersionedMessageDefinition {
    [key: string]: any | [any, ...any[]];
}

export type VersionedStreamStructure = {
    aggregateRootId: StreamDefinition['aggregateRootId'];
    messages: VersionedMessageDefinition;
};

interface MessagesThatNeedUpcasting {
    [key: string]: [any, any, ...any[]];
}

type LastTypeOf<T extends readonly unknown[]> = T extends readonly [...unknown[], infer Last] ? Last : never;

type TupleWithoutFirst<T extends [any, ...any[]]> = T extends [any, ...infer Rest] ? Rest : [];

interface TransformFunction<Type, AggregateRootId extends string | number, From, To> {
    (message: Message<Type, From, AggregateRootId>): Message<Type, To, AggregateRootId>;
}

type UpcasterFuncs<Type, AggregateRootId extends string | number, Schemas extends any[], AllSchemas extends any[]> = {
    [K in keyof Schemas]: TransformFunction<Type, AggregateRootId, AllSchemas[K & keyof AllSchemas], Schemas[K]>;
};

type OnlyMessagesThatNeedUpcasting<M extends VersionedMessageDefinition> = {
    [T in keyof M as M[T] extends [any, any, ...any[]] ? T : never]: M[T] extends [any, any, ...any[]] ? M[T] : never;
};

type UpcastersForMessages<AggregateRootId extends string | number, Messages extends MessagesThatNeedUpcasting> = {
    [T in keyof Messages]: UpcasterFuncs<T, AggregateRootId, TupleWithoutFirst<Messages[T]>, Messages[T]>;
};

export type UpcastersForVersionedStream<Stream extends VersionedStreamDefinition<Stream>> = UpcastersForMessages<
    Stream['aggregateRootId'],
    Stream['upcasters']
>;

export type DefineVersionedStream<Stream extends VersionedStreamStructure> = Omit<Stream, 'messages'> & {
    messages: {
        [T in keyof Stream['messages']]: Stream['messages'][T] extends [...any]
            ? LastTypeOf<Stream['messages'][T]>
            : Stream['messages'][T];
    };
    upcasters: OnlyMessagesThatNeedUpcasting<Stream['messages']>;
};

export interface VersionedStreamDefinition<Stream extends VersionedStreamDefinition<Stream>>
    extends StreamDefinition {
    upcasters: {
        [K in keyof Stream['upcasters']]: [any, any, ...any[]];
    };
}

export class SchemaVersionMessageDecorator<
    Stream extends VersionedStreamDefinition<Stream>,
> implements MessageDecorator<Stream> {
    constructor(private readonly upcasters: UpcastersForVersionedStream<Stream>) {}

    decorate(messages: MessagesFrom<Stream>): MessagesFrom<Stream> {
        return messages.map(message => {
            const upcasters = upcastersFor(this.upcasters, message.type);

            if (upcasters === undefined) {
                return message;
            }

            return messageWithHeader(message, {
                key: 'schema_version',
                value: upcasters.length,
            });
        });
    }
}

/**
 * The upcasters registered for a message type. The type comes off the wire, so it is looked up as
 * an own property: a type named after something every object has (`constructor`, `toString`) is an
 * unknown type, not a lookup into `Object.prototype`.
 */
function upcastersFor<Stream extends VersionedStreamDefinition<Stream>>(
    upcasters: UpcastersForVersionedStream<Stream>,
    type: AnyMessageFrom<Stream>['type'],
): UpcastersForVersionedStream<Stream>[keyof UpcastersForVersionedStream<Stream>] | undefined {
    return Object.hasOwn(upcasters, type) ? upcasters[type] : undefined;
}

function upcastMessage<Stream extends VersionedStreamDefinition<Stream>>(
    message: AnyMessageFrom<Stream>,
    upcasters: UpcastersForVersionedStream<Stream>,
): AnyMessageFrom<Stream> {
    let version = Number(message.headers.schema_version ?? 0);
    const typeUpcasters = upcastersFor(upcasters, message.type);

    if (typeUpcasters === undefined) {
        return message;
    }

    const targetVersion = typeUpcasters.length;

    while (version < targetVersion) {
        message = typeUpcasters[version]!(message);
        version++;
    }

    return message;
}

export class VersionedMessageConsumer<
    Stream extends VersionedStreamDefinition<Stream>,
> implements MessageConsumer<Stream> {
    constructor(
        private readonly upcasters: UpcastersForVersionedStream<Stream>,
        private readonly consumer: MessageConsumer<Stream>,
    ) {}

    consume(message: AnyMessageFrom<Stream>): Promise<void> {
        return this.consumer.consume(upcastMessage(message, this.upcasters));
    }
}

export class UpcastingMessageRepository<
    Stream extends VersionedStreamDefinition<Stream>,
> implements MessageRepository<Stream> {
    constructor(
        private readonly upcasters: UpcastersForVersionedStream<Stream>,
        private readonly repository: MessageRepository<Stream>,
    ) {}

    paginateIds(options: IdPaginationOptions<Stream>): AsyncGenerator<AggregateIdWithStreamOffset<Stream>> {
        return this.repository.paginateIds(options);
    }

    persist(id: Stream['aggregateRootId'], messages: MessagesFrom<Stream>): Promise<void> {
        return this.repository.persist(id, messages);
    }

    retrieveAllAfterVersion(id: Stream['aggregateRootId'], version: number): AsyncGenerator<AnyMessageFrom<Stream>> {
        return this.upcastMessages(this.repository.retrieveAllAfterVersion(id, version));
    }

    retrieveAllForAggregate(id: Stream['aggregateRootId']): AsyncGenerator<AnyMessageFrom<Stream>> {
        return this.upcastMessages(this.repository.retrieveAllForAggregate(id));
    }

    retrieveAllUntilVersion(id: Stream['aggregateRootId'], version: number): AsyncGenerator<AnyMessageFrom<Stream>> {
        return this.upcastMessages(this.repository.retrieveAllUntilVersion(id, version));
    }

    retrieveBetweenVersions(
        id: Stream['aggregateRootId'],
        after: number,
        before: number,
    ): AsyncGenerator<AnyMessageFrom<Stream>> {
        return this.upcastMessages(this.repository.retrieveBetweenVersions(id, after, before));
    }

    private async *upcastMessages(
        messages: AsyncGenerator<AnyMessageFrom<Stream>>,
    ): AsyncGenerator<AnyMessageFrom<Stream>> {
        for await (const message of messages) {
            yield upcastMessage(message, this.upcasters);
        }
    }
}

export class UpcastingOutboxRepository<
    Stream extends VersionedStreamDefinition<Stream>,
> implements OutboxRepository<Stream> {
    constructor(
        private readonly upcasters: UpcastersForVersionedStream<Stream>,
        private readonly repository: OutboxRepository<Stream>,
    ) {}

    cleanupConsumedMessages(limit: number): Promise<number> {
        return this.repository.cleanupConsumedMessages(limit);
    }

    markConsumed(messages: MessagesFrom<Stream>): Promise<void> {
        return this.repository.markConsumed(messages);
    }

    numberOfConsumedMessages(): Promise<number> {
        return this.repository.numberOfConsumedMessages();
    }

    numberOfPendingMessages(): Promise<number> {
        return this.repository.numberOfPendingMessages();
    }

    persist(messages: MessagesFrom<Stream>): Promise<void> {
        return this.repository.persist(messages);
    }

    async *retrieveBatch(size: number): AsyncGenerator<AnyMessageFrom<Stream>> {
        const messages = this.repository.retrieveBatch(size);

        for await (const message of messages) {
            yield upcastMessage(message, this.upcasters);
        }
    }

    truncate(): Promise<void> {
        return this.repository.truncate();
    }
}
