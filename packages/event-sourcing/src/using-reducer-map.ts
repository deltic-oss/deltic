import type {AnyMessageFrom, MessageHeaders, SpecificPayloadFrom} from '@deltic/messaging';
import {AggregateRootBehavior, type AggregateRootOptions, type AggregateStream} from './index.js';

type HandlerFunc<Stream extends AggregateStream<Stream>, State, Event extends keyof Stream['messages']> = (
    state: State,
    event: SpecificPayloadFrom<Stream, Event>,
    headers: MessageHeaders<Stream['aggregateRootId']>,
) => State;

export type ReducerMap<Stream extends AggregateStream<Stream>, State> = {
    [E in keyof Stream['messages']]?: HandlerFunc<Stream, State, E>;
};

export abstract class AggregateRootUsingReducerMap<
    Stream extends AggregateStream<Stream>,
    State,
> extends AggregateRootBehavior<Stream> {
    protected abstract readonly handlers: ReducerMap<Stream, State>;
    private _state: State;

    constructor(aggregateRootId: Stream['aggregateRootId'], initialState: State, options: AggregateRootOptions = {}) {
        super(aggregateRootId, options);
        this._state = structuredClone(initialState);
    }

    protected get state(): State {
        return structuredClone(this._state);
    }

    protected apply(message: AnyMessageFrom<Stream>): void {
        const handler = Object.hasOwn(this.handlers, message.type) ? this.handlers[message.type] : undefined;
        this.aggregateRootVersionNumber = Number(message.headers['aggregate_root_version'] || 1);

        if (handler) {
            this._state = handler(this._state, message.payload, message.headers);
        }
    }
}
