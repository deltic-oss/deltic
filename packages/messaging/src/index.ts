export interface StreamDefinition {
    aggregateRootId: string | number;
    messages: {
        [index: string]: any;
    };
}

export type HeaderValue = undefined | null | string | number | boolean | HeaderValue[] | HeaderValueObject;

export type HeaderValueObject = {
    [index: string | number]: HeaderValue;
};

export interface Header {
    readonly key: string;
    readonly value: HeaderValue;
}

export interface AdditionalMessageHeaders {
    [key: string | number]: HeaderValue;
}

export interface MessageHeaders<AggregateRootId extends string | number = string | number> {
    [key: string | number]: HeaderValue;
    aggregate_root_id?: AggregateRootId;
    aggregate_root_version?: number;
    time_of_recording?: string;
    time_of_recording_ms?: number;
    schema_version?: number;
}

export interface Message<Type, Payload, AggregateRootId extends string | number = string | number> {
    readonly headers: MessageHeaders<AggregateRootId>;
    readonly type: Type;
    readonly payload: Payload;
}

export type MessageHandlers<Stream extends StreamDefinition> = {
    readonly [K in keyof Stream['messages']]: (
        message: Message<K, Stream['messages'][K], Stream['aggregateRootId']>,
    ) => Promise<void>;
};

export type AnyMessageTypeFromStream<Stream extends StreamDefinition> = keyof Stream['messages'];

export type MessagesPerMessageType<Stream extends StreamDefinition> = {
    [K in keyof Stream['messages']]: Message<K, Stream['messages'][K], Stream['aggregateRootId']>;
};

export type AnyMessageFrom<Stream extends StreamDefinition> =
    MessagesPerMessageType<Stream>[keyof MessagesPerMessageType<Stream>];
export type AnyPayloadFromStream<Stream extends StreamDefinition> = AnyMessageFrom<Stream>['payload'];
export type SpecificMessageFrom<
    Stream extends StreamDefinition,
    Type extends keyof MessagesPerMessageType<Stream>,
> = MessagesPerMessageType<Stream>[Type];
export type SpecificPayloadFrom<
    Stream extends StreamDefinition,
    Type extends keyof Stream['messages'],
> = Stream['messages'][Type];
export type MessagesFrom<Stream extends StreamDefinition> = AnyMessageFrom<Stream>[];

export interface MessageConsumerFunc<Stream extends StreamDefinition> {
    (message: AnyMessageFrom<Stream>): Promise<void>;
}

export interface MessageConsumer<Stream extends StreamDefinition> {
    consume(message: AnyMessageFrom<Stream>): Promise<void>;
}

export interface MessageDispatcherFunc<Stream extends StreamDefinition> {
    (...messages: MessagesFrom<Stream>): Promise<void>;
}

export interface MessageDispatcher<Stream extends StreamDefinition> {
    send(...messages: MessagesFrom<Stream>): Promise<void>;
}

export interface MessageDecorator<Stream extends StreamDefinition> {
    decorate(messages: MessagesFrom<Stream>): MessagesFrom<Stream>;
}

export interface MessageDecoratorFunc<Stream extends StreamDefinition> {
    <M extends AnyMessageFrom<Stream>>(message: M): M;
}

export type WhichMessageToProbe = 'first' | 'last';

export interface AggregateIdWithStreamOffset<Stream extends StreamDefinition> {
    version: number;
    id: Stream['aggregateRootId'];
    message: AnyMessageFrom<Stream>;
}

export interface IdPaginationOptions<Stream extends StreamDefinition> {
    limit: number;
    afterId?: Stream['aggregateRootId'] | undefined;
    whichMessage?: WhichMessageToProbe;
}

export interface MessageRepository<Stream extends StreamDefinition> {
    persist(id: Stream['aggregateRootId'], messages: MessagesFrom<Stream>): Promise<void>;

    retrieveAllForAggregate(id: Stream['aggregateRootId']): AsyncGenerator<AnyMessageFrom<Stream>>;

    retrieveAllAfterVersion(id: Stream['aggregateRootId'], version: number): AsyncGenerator<AnyMessageFrom<Stream>>;

    retrieveAllUntilVersion(id: Stream['aggregateRootId'], version: number): AsyncGenerator<AnyMessageFrom<Stream>>;

    retrieveBetweenVersions(
        id: Stream['aggregateRootId'],
        after: number,
        before: number,
    ): AsyncGenerator<AnyMessageFrom<Stream>>;

    paginateIds(options: IdPaginationOptions<Stream>): AsyncGenerator<AggregateIdWithStreamOffset<Stream>>;
}
