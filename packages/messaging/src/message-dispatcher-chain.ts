import type {MessageDispatcher, MessagesFrom, StreamDefinition} from './index.js';

/**
 * Hands messages to its dispatchers one after the other, in the order they were given, and
 * stops at the first one that fails. The chain settles only once no dispatcher is running, so
 * whatever is scoped around it (a transaction) covers every dispatcher that ran.
 */
export class MessageDispatcherChain<Stream extends StreamDefinition> implements MessageDispatcher<Stream> {
    private dispatchers: MessageDispatcher<Stream>[] = [];

    constructor(...dispatchers: MessageDispatcher<Stream>[]) {
        this.dispatchers = dispatchers;
    }

    async send(...messages: MessagesFrom<Stream>): Promise<void> {
        for (const dispatcher of this.dispatchers) {
            await dispatcher.send(...messages);
        }
    }
}
