import type {AnyMessageFrom, MessageConsumer, StreamDefinition} from './index.js';
import {CollectingMessageConsumer} from './collecting-message-consumer.js';
import {MessageConsumerChain} from './message-consumer-chain.js';
import {createMessage} from './helpers.js';

interface ExampleStream extends StreamDefinition {
    aggregateRootId: string;
    messages: {
        example: {value: string};
    };
}

const message: AnyMessageFrom<ExampleStream> = createMessage<ExampleStream>('example', {value: 'payload'}, {
    aggregate_root_id: 'aggregate-1',
});

describe('MessageConsumerChain', () => {
    test('every consumer in the chain receives the message', async () => {
        const first = new CollectingMessageConsumer<ExampleStream>();
        const second = new CollectingMessageConsumer<ExampleStream>();
        const chain = new MessageConsumerChain<ExampleStream>(first, second);

        await chain.consume(message);

        expect(first.messages).toEqual([message]);
        expect(second.messages).toEqual([message]);
    });

    test('an empty chain consumes without doing anything', async () => {
        const chain = new MessageConsumerChain<ExampleStream>();

        await expect(chain.consume(message)).resolves.toBeUndefined();
    });

    /**
     * The chain stops at the first failure. A relay that nacks on failure redelivers the
     * message to the whole chain, so the consumers before the failing one receive it
     * again — which is why the consumers behind a chain need to be idempotent.
     */
    test('a failing consumer stops the chain before the consumers after it', async () => {
        const before = new CollectingMessageConsumer<ExampleStream>();
        const after = new CollectingMessageConsumer<ExampleStream>();
        const failing: MessageConsumer<ExampleStream> = {
            async consume() {
                throw new Error('projection is broken');
            },
        };
        const chain = new MessageConsumerChain<ExampleStream>(before, failing, after);

        await expect(chain.consume(message)).rejects.toThrow('projection is broken');

        expect(before.messages).toEqual([message]);
        expect(after.messages).toEqual([]);
    });

    /**
     * Order in the constructor is order of execution, so a consumer that has to observe
     * the effect of another one — a webhook that embeds a projection, for instance — can
     * be placed after it.
     */
    test('consumers run one after the other, in the order they were given', async () => {
        const order: string[] = [];
        const firstStarted = Promise.withResolvers<void>();
        const releaseFirst = Promise.withResolvers<void>();
        const chain = new MessageConsumerChain<ExampleStream>(
            {
                async consume() {
                    order.push('first started');
                    firstStarted.resolve();
                    await releaseFirst.promise;
                    order.push('first finished');
                },
            },
            {
                async consume() {
                    order.push('second started');
                },
            },
        );

        const consuming = chain.consume(message);
        await firstStarted.promise;

        expect(order).toEqual(['first started']);

        releaseFirst.resolve();
        await consuming;

        expect(order).toEqual(['first started', 'first finished', 'second started']);
    });

    /**
     * Whatever wraps the chain scopes a resource around `consume()`: a lock held by the
     * LockingMessageConsumer, a transaction, a connection scope. That scope ends when the
     * chain settles, so a consumer that is still running at that point works outside of
     * it — on an aggregate whose lock was already released, or after its transaction was
     * rolled back.
     */
    test('the chain only settles once no consumer is running any more', async () => {
        const events: string[] = [];
        const releaseSlow = Promise.withResolvers<void>();
        const chain = new MessageConsumerChain<ExampleStream>(
            {
                async consume() {
                    await releaseSlow.promise;
                    events.push('slow consumer finished');
                },
            },
            {
                async consume() {
                    throw new Error('projection is broken');
                },
            },
        );

        const consuming = chain.consume(message).catch(() => {
            events.push('chain settled');
        });
        setImmediate(() => releaseSlow.resolve());
        await consuming;

        expect(events).toEqual(['slow consumer finished', 'chain settled']);
    });

    test('the first failure is reported when multiple consumers fail', async () => {
        const chain = new MessageConsumerChain<ExampleStream>(
            {
                async consume() {
                    throw new Error('first failure');
                },
            },
            {
                async consume() {
                    throw new Error('second failure');
                },
            },
        );

        await expect(chain.consume(message)).rejects.toThrow('first failure');
    });
});
