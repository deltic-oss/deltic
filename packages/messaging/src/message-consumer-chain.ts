import type {AnyMessageFrom, MessageConsumer, StreamDefinition} from './index.js';

/**
 * Hands a message to its consumers one after the other, in the order they were given, and
 * stops at the first one that fails. The chain settles only once no consumer is running, so
 * whatever is scoped around it (a lock, a transaction) covers every consumer that ran.
 */
export class MessageConsumerChain<Stream extends StreamDefinition> implements MessageConsumer<Stream> {
    private consumers: MessageConsumer<Stream>[] = [];

    constructor(...consumers: MessageConsumer<Stream>[]) {
        this.consumers = consumers;
    }

    async consume(message: AnyMessageFrom<Stream>): Promise<void> {
        for (const consumer of this.consumers) {
            await consumer.consume(message);
        }
    }
}
