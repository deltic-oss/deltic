import type {MessageDispatcher, StreamDefinition} from './index.js';
import {CollectingMessageDispatcher} from './collecting-message-dispatcher.js';
import {DispatchingMessageConsumer} from './dispatching-message-consumer.js';
import {createMessage} from './helpers.js';

interface ExampleStream extends StreamDefinition {
    aggregateRootId: string;
    messages: {
        example: {value: string};
    };
}

describe('DispatchingMessageConsumer', () => {
    test('every consumed message is sent as a separate dispatch', async () => {
        const dispatcher = new CollectingMessageDispatcher<ExampleStream>();
        const consumer = new DispatchingMessageConsumer<ExampleStream>(dispatcher);
        const first = createMessage<ExampleStream>('example', {value: 'one'});
        const second = createMessage<ExampleStream>('example', {value: 'two'});

        await consumer.consume(first);
        await consumer.consume(second);

        expect(dispatcher.producedMessages()).toEqual([first, second]);
        expect(dispatcher.dispatchCount).toEqual(2);
    });

    /**
     * This consumer is what bridges an inbound relay to an outbox or broker. When the
     * dispatch fails the failure has to reach the relay, otherwise the relay acks a
     * message that was never forwarded.
     */
    test('a failing dispatch fails consumption', async () => {
        const dispatcher: MessageDispatcher<ExampleStream> = {
            async send() {
                throw new Error('broker unavailable');
            },
        };
        const consumer = new DispatchingMessageConsumer<ExampleStream>(dispatcher);

        await expect(consumer.consume(createMessage<ExampleStream>('example', {value: 'one'})))
            .rejects.toThrow('broker unavailable');
    });
});
