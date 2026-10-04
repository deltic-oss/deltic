import type {MessageDispatcher, MessagesFrom, StreamDefinition} from './index.js';
import {collect, messageFactory, withoutHeaders} from './helpers.js';
import {CollectingMessageDispatcher} from './collecting-message-dispatcher.js';
import {
    OUTBOX_CONSUMED_HEADER_KEY,
    OUTBOX_ID_HEADER_KEY,
    OutboxMessageDispatcher,
    OutboxRelay,
    OutboxRepositoryUsingMemory,
} from './outbox.js';

interface ExampleStream extends StreamDefinition {
    aggregateRootId: string | number;
    messages: {
        ping: number;
        pong: number;
    };
}

const createMessage = messageFactory<ExampleStream>();

function failingDispatcher(reason: string): MessageDispatcher<ExampleStream> {
    return {
        async send() {
            throw new Error(reason);
        },
    };
}

describe('OutboxMessageDispatcher', () => {
    test('sent messages are persisted in the outbox instead of being dispatched', async () => {
        const outbox = new OutboxRepositoryUsingMemory<ExampleStream>();
        const dispatcher = new OutboxMessageDispatcher<ExampleStream>(outbox);

        await dispatcher.send(createMessage('ping', 1), createMessage('pong', 2));

        expect(await outbox.numberOfPendingMessages()).toEqual(2);
        expect(await outbox.numberOfConsumedMessages()).toEqual(0);
    });

    test('sending nothing leaves the outbox untouched', async () => {
        const outbox = new OutboxRepositoryUsingMemory<ExampleStream>();
        const dispatcher = new OutboxMessageDispatcher<ExampleStream>(outbox);

        await dispatcher.send();

        expect(await outbox.numberOfPendingMessages()).toEqual(0);
    });
});

describe('OutboxRelay', () => {
    let outbox: OutboxRepositoryUsingMemory<ExampleStream>;
    let collecting: CollectingMessageDispatcher<ExampleStream>;

    beforeEach(() => {
        outbox = new OutboxRepositoryUsingMemory<ExampleStream>();
        collecting = new CollectingMessageDispatcher<ExampleStream>();
    });

    test('an empty outbox relays nothing and dispatches nothing', async () => {
        const relay = new OutboxRelay<ExampleStream>(outbox, collecting);

        expect(await relay.relayBatch(10, 5)).toEqual(0);
        expect(collecting.dispatchCount).toEqual(0);
    });

    test('a batch smaller than the commit size is dispatched in one go', async () => {
        await outbox.persist([createMessage('ping', 1), createMessage('pong', 2)]);
        const relay = new OutboxRelay<ExampleStream>(outbox, collecting);

        expect(await relay.relayBatch(10, 25)).toEqual(2);
        expect(collecting.dispatchCount).toEqual(1);
        expect(await outbox.numberOfPendingMessages()).toEqual(0);
    });

    test('messages are relayed in the order they were persisted', async () => {
        await outbox.persist([createMessage('ping', 1)]);
        await outbox.persist([createMessage('pong', 2), createMessage('ping', 3)]);
        const relay = new OutboxRelay<ExampleStream>(outbox, collecting);

        await relay.relayBatch(10, 1);

        expect(collecting.producedMessages().map(withoutHeaders)).toEqual([
            createMessage('ping', 1),
            createMessage('pong', 2),
            createMessage('ping', 3),
        ]);
    });

    /**
     * The whole point of the outbox: a message that could not be handed to the broker
     * stays pending so a later relay picks it up again.
     */
    test('messages are not marked consumed when the dispatcher fails', async () => {
        await outbox.persist([createMessage('ping', 1), createMessage('pong', 2)]);
        const relay = new OutboxRelay<ExampleStream>(outbox, failingDispatcher('broker unavailable'));

        await expect(relay.relayBatch(10, 25)).rejects.toThrow('broker unavailable');

        expect(await outbox.numberOfPendingMessages()).toEqual(2);
        expect(await outbox.numberOfConsumedMessages()).toEqual(0);
    });

    /**
     * A relay that dies half-way through a batch may only lose the progress of the
     * commit that was in flight, never the progress of the commits before it.
     */
    test('a failure half-way through a batch keeps the already dispatched commits consumed', async () => {
        await outbox.persist([
            createMessage('ping', 1),
            createMessage('ping', 2),
            createMessage('ping', 3),
            createMessage('ping', 4),
        ]);
        const dispatched: MessagesFrom<ExampleStream> = [];
        const dispatcher: MessageDispatcher<ExampleStream> = {
            async send(...messages) {
                if (messages.some(m => m.payload === 3)) {
                    throw new Error('broker unavailable');
                }

                dispatched.push(...messages);
            },
        };
        const relay = new OutboxRelay<ExampleStream>(outbox, dispatcher);

        await expect(relay.relayBatch(10, 2)).rejects.toThrow('broker unavailable');

        expect(dispatched.map(m => m.payload)).toEqual([1, 2]);
        expect(await outbox.numberOfConsumedMessages()).toEqual(2);
        expect((await collect(outbox.retrieveBatch(10))).map(m => m.payload)).toEqual([3, 4]);
    });

    /**
     * Marking messages as consumed happens after the dispatch, so a failure in between
     * duplicates messages rather than losing them. Consumers must be idempotent.
     */
    test('a failure to mark messages consumed leads to redelivery, not to loss', async () => {
        await outbox.persist([createMessage('ping', 1)]);
        const markConsumed = outbox.markConsumed.bind(outbox);
        let shouldFail = true;
        outbox.markConsumed = async messages => {
            if (shouldFail) {
                shouldFail = false;

                throw new Error('connection lost');
            }

            return markConsumed(messages);
        };
        const relay = new OutboxRelay<ExampleStream>(outbox, collecting);

        await expect(relay.relayBatch(10, 25)).rejects.toThrow('connection lost');
        await relay.relayBatch(10, 25);

        expect(collecting.producedMessages().map(m => m.payload)).toEqual([1, 1]);
        expect(await outbox.numberOfPendingMessages()).toEqual(0);
    });

    test('the batch size limits how many messages a single relay round picks up', async () => {
        await outbox.persist([
            createMessage('ping', 1),
            createMessage('ping', 2),
            createMessage('ping', 3),
        ]);
        const relay = new OutboxRelay<ExampleStream>(outbox, collecting);

        expect(await relay.relayBatch(2, 1)).toEqual(2);
        expect(await outbox.numberOfPendingMessages()).toEqual(1);
    });

    /**
     * Nothing in the relay itself prevents two relays from picking up the same batch;
     * that is what the mutex in the relay runners is for.
     */
    test('two relays over the same outbox dispatch the same messages twice', async () => {
        await outbox.persist([createMessage('ping', 1)]);
        const second = new CollectingMessageDispatcher<ExampleStream>();

        await Promise.all([
            new OutboxRelay<ExampleStream>(outbox, collecting).relayBatch(10, 25),
            new OutboxRelay<ExampleStream>(outbox, second).relayBatch(10, 25),
        ]);

        expect(collecting.producedMessages()).toHaveLength(1);
        expect(second.producedMessages()).toHaveLength(1);
    });
});

describe('OutboxRepositoryUsingMemory', () => {
    let outbox: OutboxRepositoryUsingMemory<ExampleStream>;

    beforeEach(() => {
        outbox = new OutboxRepositoryUsingMemory<ExampleStream>();
    });

    test('retrieved messages carry the outbox id needed to mark them consumed', async () => {
        await outbox.persist([createMessage('ping', 1), createMessage('pong', 2)]);

        const retrieved = await collect(outbox.retrieveBatch(10));

        expect(retrieved.map(m => m.headers[OUTBOX_ID_HEADER_KEY])).toEqual([1, 2]);
        expect(retrieved.map(m => m.headers[OUTBOX_CONSUMED_HEADER_KEY])).toEqual(['no', 'no']);
    });

    test('marking an empty list of messages consumed changes nothing', async () => {
        await outbox.persist([createMessage('ping', 1)]);

        await outbox.markConsumed([]);

        expect(await outbox.numberOfPendingMessages()).toEqual(1);
    });

    test('cleanup only removes consumed messages and reports how many it removed', async () => {
        await outbox.persist([createMessage('ping', 1), createMessage('ping', 2), createMessage('ping', 3)]);
        await outbox.markConsumed(await collect(outbox.retrieveBatch(2)));

        expect(await outbox.cleanupConsumedMessages(10)).toEqual(2);
        expect(await outbox.cleanupConsumedMessages(10)).toEqual(0);
        expect(await outbox.numberOfPendingMessages()).toEqual(1);
    });

    test('truncating clears both pending and consumed messages', async () => {
        await outbox.persist([createMessage('ping', 1), createMessage('ping', 2)]);
        await outbox.markConsumed(await collect(outbox.retrieveBatch(1)));

        await outbox.truncate();

        expect(await outbox.numberOfPendingMessages()).toEqual(0);
        expect(await outbox.numberOfConsumedMessages()).toEqual(0);
    });
});
