import type {AnyMessageFrom, MessageConsumer, StreamDefinition} from './index.js';
import {setTimeout as wait} from 'node:timers/promises';
import {SequentialMessageConsumer} from './sequential-message-consumer.js';

interface DelayedResolvingStream extends StreamDefinition {
    topic: 'delayed';
    messages: {
        delayed: number;
    };
}

class DelayedConsumer implements MessageConsumer<DelayedResolvingStream> {
    public consumedDelays: number[] = [];
    async consume(message: AnyMessageFrom<DelayedResolvingStream>) {
        const delay = message.payload;
        this.consumedDelays.push(delay);
        await wait(delay);
        this.consumedDelays.push(delay);
    }
}

class ExceptionInducingMessageConsumer implements MessageConsumer<DelayedResolvingStream> {
    async consume() {
        throw new Error('something went wrong');
    }
}

describe('SynchronousMessageConsumer', () => {
    /**
     * This test proves the SynchronousMessageConsumer ensures wrapped
     * consumers process messages synchronously. The test below validated
     * the normal behaviour of the DelayedConsumer.
     */
    test('it consumes synchronously', async () => {
        const delayedConsumer = new DelayedConsumer();
        const synchronousConsumer = new SequentialMessageConsumer<DelayedResolvingStream>(delayedConsumer);
        const delays = [50, 1, 25];
        const promises = delays.map(delay =>
            synchronousConsumer.consume({headers: {}, type: 'delayed', payload: delay}),
        );
        await Promise.all(promises);
        expect(delayedConsumer.consumedDelays).toEqual([50, 50, 1, 1, 25, 25]);
    });

    /**
     * This test proves the synchronous consumer ensures the underlying consumer
     * consumes the messages synchronously, even though it doesn't process it
     * that way normally.
     */
    test('DelayedConsumes consumes asynchronously', async () => {
        const delayedConsumer = new DelayedConsumer();
        const delays = [50, 1, 25];
        const promises = delays.map(delay => delayedConsumer.consume({headers: {}, type: 'delayed', payload: delay}));
        await Promise.all(promises);
        await wait(10);
        expect(delayedConsumer.consumedDelays).toEqual([50, 1, 25, 1, 25, 50]);
    });

    test('it bubbles errors up', async () => {
        const exceptionInducingConsumer = new ExceptionInducingMessageConsumer();
        const synchronousMessageConsumer = new SequentialMessageConsumer<DelayedResolvingStream>(
            exceptionInducingConsumer,
        );

        await expect(synchronousMessageConsumer.consume({headers: {}, type: 'delayed', payload: 4})).rejects.toEqual(
            new Error('something went wrong'),
        );
    });

});
