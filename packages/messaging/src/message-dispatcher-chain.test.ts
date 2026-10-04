import {CollectingMessageDispatcher} from './collecting-message-dispatcher.js';
import type {MessagesFrom} from './index.js';
import {MessageDispatcherChain} from './message-dispatcher-chain.js';

describe('MessageDispatcherChain', () => {
    let dispatcher: MessageDispatcherChain<any>;
    let delegate1: CollectingMessageDispatcher<any>;
    let delegate2: CollectingMessageDispatcher<any>;
    const messages: MessagesFrom<any> = [
        {type: 'any', payload: 'first', headers: {}},
        {type: 'any', payload: 'second', headers: {}},
    ];

    beforeEach(() => {
        // arrange
        delegate1 = new CollectingMessageDispatcher();
        delegate2 = new CollectingMessageDispatcher();
        dispatcher = new MessageDispatcherChain(delegate1, delegate2);
    });

    test('dispatched messages are delegated', async () => {
        // act
        await dispatcher.send(...messages);

        // assert
        expect(delegate1.dispatchCount).toEqual(1);
        expect(delegate1.producedMessages()).toEqual(messages);
        expect(delegate2.dispatchCount).toEqual(1);
        expect(delegate2.producedMessages()).toEqual(messages);
    });

    test('an empty chain dispatches without doing anything', async () => {
        const emptyChain = new MessageDispatcherChain<any>();

        await expect(emptyChain.send(...messages)).resolves.toBeUndefined();
    });

    test('dispatching no messages still reaches every delegate', async () => {
        await dispatcher.send();

        expect(delegate1.dispatchCount).toEqual(1);
        expect(delegate2.dispatchCount).toEqual(1);
        expect(delegate1.producedMessages()).toEqual([]);
    });

    /**
     * The chain is a pipeline: a delegate that must run before another one — an outbox
     * write before synchronous consumers, for instance — is expressed by putting it
     * earlier in the chain.
     */
    test('delegates run one after the other, in the order they were given', async () => {
        const order: string[] = [];
        const firstStarted = Promise.withResolvers<void>();
        const releaseFirst = Promise.withResolvers<void>();
        const chain = new MessageDispatcherChain<any>(
            {
                async send() {
                    order.push('first started');
                    firstStarted.resolve();
                    await releaseFirst.promise;
                    order.push('first finished');
                },
            },
            {
                async send() {
                    order.push('second started');
                },
            },
        );

        const dispatching = chain.send(...messages);
        await firstStarted.promise;

        expect(order).toEqual(['first started']);

        releaseFirst.resolve();
        await dispatching;

        expect(order).toEqual(['first started', 'first finished', 'second started']);
    });

    /**
     * The chain has no way to undo a dispatch that already succeeded. When one leg
     * fails, an outbox relay will not mark the batch as consumed and will retry it,
     * so the legs before the failing one receive the messages twice.
     */
    test('a failing delegate stops the chain before the delegates after it', async () => {
        const failing = {
            async send() {
                throw new Error('broker unavailable');
            },
        };
        const chain = new MessageDispatcherChain<any>(delegate1, failing, delegate2);

        await expect(chain.send(...messages)).rejects.toThrow('broker unavailable');

        expect(delegate1.producedMessages()).toEqual(messages);
        expect(delegate2.producedMessages()).toEqual([]);
    });

    /**
     * The aggregate repository dispatches inside its transaction and rolls back when the
     * dispatcher rejects. A delegate still running at that point — an outbox write next
     * to a failing synchronous consumer — can write after the rollback, outside of the
     * transaction it was meant to be part of.
     */
    test('the chain only settles once no delegate is running any more', async () => {
        const events: string[] = [];
        const releaseSlow = Promise.withResolvers<void>();
        const chain = new MessageDispatcherChain<any>(
            {
                async send() {
                    await releaseSlow.promise;
                    events.push('slow delegate finished');
                },
            },
            {
                async send() {
                    throw new Error('broker unavailable');
                },
            },
        );

        const dispatching = chain.send(...messages).catch(() => {
            events.push('chain settled');
        });
        setImmediate(() => releaseSlow.resolve());
        await dispatching;

        expect(events).toEqual(['slow delegate finished', 'chain settled']);
    });
});
