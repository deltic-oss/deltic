import type {AnyMessageFrom, MessageHeaders, SpecificPayloadFrom} from '@deltic/messaging';
import {AggregateRootBehavior, type AggregateRootOptions, type AggregateStream} from './index.js';

type HandlerFunc<Stream extends AggregateStream<Stream>, Event extends keyof Stream['messages']> = (
    this: Stream['aggregateRoot'],
    event: SpecificPayloadFrom<Stream, Event>,
    headers: MessageHeaders<Stream['aggregateRootId']>,
) => void;

export type HandlerMap<Stream extends AggregateStream<Stream>> = {
    [E in keyof Stream['messages']]?: HandlerFunc<Stream, E>;
};

export abstract class AggregateRootUsingHandlerMap<
    Stream extends AggregateStream<Stream>,
> extends AggregateRootBehavior<Stream> {
    protected abstract readonly handlers: HandlerMap<Stream>;

    constructor(aggregateRootId: Stream['aggregateRootId'], options: AggregateRootOptions = {}) {
        super(aggregateRootId, options);
    }

    protected apply(message: AnyMessageFrom<Stream>): void {
        const handler = Object.hasOwn(this.handlers, message.type) ? this.handlers[message.type] : undefined;

        this.aggregateRootVersionNumber = Number(message.headers['aggregate_root_version'] || 1);

        handler?.apply(this, [message.payload, message.headers]);
    }
}
