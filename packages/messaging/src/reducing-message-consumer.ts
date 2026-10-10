import type {AnyMessageFrom, Message, MessageConsumer, StreamDefinition} from './index.js';
import type {KeyValueStore} from '@deltic/key-value';

export type Reducer<State, Payload> = (state: State, payload: Payload) => State | Promise<State>;
export type EveryReducerPerType<State, Stream extends StreamDefinition> = {
    [T in keyof Stream['messages']]: Reducer<State, Message<T, Stream['messages'][T]>>;
};
export type SomeReducersPerType<State, Stream extends StreamDefinition> = {
    [K in keyof EveryReducerPerType<State, Stream>]?: EveryReducerPerType<State, Stream>[K];
};

export type MessageReducer<State, Stream extends StreamDefinition> = Reducer<State, AnyMessageFrom<Stream>>;
export type StateType =
    | string
    | number
    | null
    | object
    | undefined
    | boolean
    | {[index: string | number]: StateType}
    | Array<StateType>;
export type StateKey = string | number | object | {[index: string]: string | number | boolean | null | undefined};
export type StateKeyResolver<Key, Stream extends StreamDefinition> = (message: AnyMessageFrom<Stream>) => Key;

export function routeEveryToReducer<State, Stream extends StreamDefinition>(
    reducers: EveryReducerPerType<State, Stream>,
): MessageReducer<State, Stream> {
    return routeSomeToReducer<State, Stream>(reducers);
}

export function routeSomeToReducer<State, Stream extends StreamDefinition>(
    reducers: SomeReducersPerType<State, Stream>,
): MessageReducer<State, Stream> {
    return async (state, message) => {
        const type = message.type;
        // The type comes off the wire: an own-property lookup keeps a type named after an
        // Object.prototype member (`toString`, `constructor`) from being called as a reducer.
        const reducer = Object.hasOwn(reducers, type) ? reducers[type] : undefined;

        return reducer === undefined ? state : reducer(state, message);
    };
}

export class ReducingMessageConsumer<
    Key extends StateKey,
    State extends StateType,
    Stream extends StreamDefinition,
> implements MessageConsumer<Stream> {
    constructor(
        private readonly store: KeyValueStore<Key, State>,
        private readonly keyResolver: StateKeyResolver<Key, Stream>,
        private readonly initialState: () => State,
        private readonly reducer: MessageReducer<State, Stream>,
    ) {}

    async consume(message: AnyMessageFrom<Stream>): Promise<void> {
        const key = this.keyResolver(message);
        const state = (await this.store.retrieve(key)) ?? this.initialState();
        const newState = await this.reducer(state, message);
        await this.store.persist(key, newState);
    }
}
