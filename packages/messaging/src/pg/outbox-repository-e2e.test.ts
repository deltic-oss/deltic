import {OutboxRepositoryUsingPg} from './outbox-repository.js';
import {collect, messageFactory, withoutHeaders} from '@deltic/messaging/helpers';
import {Pool} from 'pg';
import {pgTestCredentials} from '../../../pg-credentials.js';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {
    OutboxMessageDispatcher,
    type OutboxRepository,
    OutboxRepositoryUsingMemory,
    OutboxRelay,
} from '@deltic/messaging/outbox';
import {CollectingMessageDispatcher} from '@deltic/messaging/collecting-message-dispatcher';

interface ExampleStream {
    aggregateRootId: string | number;
    messages: {
        ping: number;
        pong: number;
    };
}

let pool: Pool;
let asyncPool: AsyncPgPool;

beforeAll(async () => {
    pool = new Pool(pgTestCredentials);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS test_outbox_repository (
            id BIGSERIAL PRIMARY KEY,
            consumed BOOLEAN NOT NULL,
            payload JSON NOT NULL
        );
        
        CREATE INDEX IF NOT EXISTS idx_test_outbox_repository_not_consumed 
            ON test_outbox_repository (id) 
            WHERE consumed = FALSE;
    `);
});

beforeEach(() => {
    asyncPool = new AsyncPgPool(pool);
});

afterAll(async () => {
    await asyncPool.flush();
    await pool.end();
});

describe.each([
    ['using Memory', () => new OutboxRepositoryUsingMemory<ExampleStream>()],
    ['using Knex', () => new OutboxRepositoryUsingPg<ExampleStream>(asyncPool, 'test_outbox_repository')],
])('Outbox Repository %s', (_name, provider: () => OutboxRepository<ExampleStream>) => {
    const createMessage = messageFactory<ExampleStream>();
    let repository: OutboxRepository<ExampleStream>;
    let dispatcher: OutboxMessageDispatcher<ExampleStream>;
    let relay: OutboxRelay<ExampleStream>;
    let collectingDispatcher: CollectingMessageDispatcher<ExampleStream>;
    const example1 = createMessage('ping', 1);
    const example2 = createMessage('pong', 2);
    const example3 = createMessage('ping', 3);
    const example4 = createMessage('pong', 3);
    const examples = [example1, example2, example3, example4];

    beforeEach(() => {
        repository = provider();
        dispatcher = new OutboxMessageDispatcher(repository);
        collectingDispatcher = new CollectingMessageDispatcher<ExampleStream>();
        relay = new OutboxRelay(repository, collectingDispatcher);
    });
    afterEach(async () => {
        await repository.truncate();
        await asyncPool.flush();
    });

    test('dispatching messages end up in the outbox repository', async () => {
        // arrange
        await dispatcher.send(...examples);

        // act
        const retrieved = await collect(repository.retrieveBatch(10));

        // assert
        expect(retrieved.map(withoutHeaders)).toEqual([example1, example2, example3, example4]);
    });

    test('batch size must limit the amount of messages fetched', async () => {
        // arrange
        await dispatcher.send(...examples);

        // act
        const retrieved = await collect(repository.retrieveBatch(2));

        // assert
        expect(retrieved.map(withoutHeaders)).toEqual([example1, example2]);
    });

    test('consumed messages are not retrieved', async () => {
        // arrange
        await dispatcher.send(...examples);

        // act
        const toBeMarkedAsConsumed = await collect(repository.retrieveBatch(2));
        await repository.markConsumed(toBeMarkedAsConsumed);
        const retrieved = await collect(repository.retrieveBatch(10));

        // assert
        expect(retrieved.map(withoutHeaders)).toEqual([example3, example4]);
    });

    test('relayed messages are dispatched onto another dispatcher', async () => {
        // arrange
        await dispatcher.send(...examples);

        // act
        await relay.relayBatch(3, 2);

        // assert
        expect(collectingDispatcher.dispatchCount).toEqual(2);
        expect(collectingDispatcher.producedMessages().map(withoutHeaders)).toEqual([example1, example2, example3]);
    });

    test('it can give counts of consumed and pending messages', async () => {
        // arrange
        await dispatcher.send(...examples);
        const toBeMarkedAsConsumed = await collect(repository.retrieveBatch(3));
        await repository.markConsumed(toBeMarkedAsConsumed);

        // act
        const pendingCount = await repository.numberOfPendingMessages();
        const consumedCount = await repository.numberOfConsumedMessages();

        // assert
        expect(pendingCount).toEqual(1);
        expect(consumedCount).toEqual(3);
    });

    test('it can clean up consumed messages', async () => {
        // arrange
        await dispatcher.send(...examples, ...examples, ...examples);
        // 0 consumed, 12 pending
        const toBeMarkedAsConsumed = await collect(repository.retrieveBatch(7));
        await repository.markConsumed(toBeMarkedAsConsumed);
        // 7 consumed, 5 pending

        // act
        const amountCleaned = await repository.cleanupConsumedMessages(3);
        // 4 consumed, 5 pending
        const pendingLeft = await repository.numberOfPendingMessages();
        const consumedLeft = await repository.numberOfConsumedMessages();
        const secondClean = await repository.cleanupConsumedMessages(1000);

        // assert
        expect(amountCleaned).toEqual(3);
        expect(pendingLeft).toEqual(5);
        expect(consumedLeft).toEqual(4);
        expect(secondClean).toEqual(4);
    });

    test('persisting no messages is a no-op', async () => {
        await dispatcher.send();

        expect(await repository.numberOfPendingMessages()).toEqual(0);
    });

    test('marking no messages as consumed is a no-op', async () => {
        await dispatcher.send(example1);

        await repository.markConsumed([]);

        expect(await repository.numberOfPendingMessages()).toEqual(1);
        expect(await repository.numberOfConsumedMessages()).toEqual(0);
    });

    test('a batch size of zero retrieves nothing', async () => {
        await dispatcher.send(...examples);

        expect(await collect(repository.retrieveBatch(0))).toEqual([]);
    });

    test('messages keep the order they were persisted in across separate writes', async () => {
        await dispatcher.send(example1);
        await dispatcher.send(example2, example3);
        await dispatcher.send(example4);

        expect((await collect(repository.retrieveBatch(10))).map(withoutHeaders)).toEqual(examples);
    });

    /**
     * The outbox exists so a message survives a broker that is unavailable. A dispatch
     * that failed must leave the messages pending for the next relay round.
     */
    test('messages are relayed again when the dispatcher fails', async () => {
        await dispatcher.send(example1, example2);
        const failingRelay = new OutboxRelay<ExampleStream>(repository, {
            async send() {
                throw new Error('broker unavailable');
            },
        });

        await expect(failingRelay.relayBatch(10, 25)).rejects.toThrow('broker unavailable');
        expect(await repository.numberOfPendingMessages()).toEqual(2);

        await relay.relayBatch(10, 25);

        expect(collectingDispatcher.producedMessages().map(withoutHeaders)).toEqual([example1, example2]);
        expect(await repository.numberOfPendingMessages()).toEqual(0);
    });
});

describe('OutboxRepositoryUsingPg', () => {
    const createMessage = messageFactory<ExampleStream>();
    let repository: OutboxRepositoryUsingPg<ExampleStream>;

    beforeEach(() => {
        repository = new OutboxRepositoryUsingPg<ExampleStream>(asyncPool, 'test_outbox_repository');
    });

    afterEach(async () => {
        await repository.truncate();
        await asyncPool.flush();
    });

    /**
     * The transactional outbox only works if the message is written in the same
     * transaction as the data the operation produced. If the operation rolls back, the
     * message must be gone with it — otherwise consumers are told about something that
     * never happened.
     */
    test('a message written in a transaction that rolls back is not in the outbox', async () => {
        await expect(asyncPool.runInTransaction(async () => {
            await repository.persist([createMessage('ping', 1)]);

            expect(await repository.numberOfPendingMessages()).toEqual(1);

            throw new Error('the operation around the outbox write failed');
        })).rejects.toThrow('the operation around the outbox write failed');

        expect(await repository.numberOfPendingMessages()).toEqual(0);
    });

    test('a message written in a transaction that commits is in the outbox', async () => {
        await asyncPool.runInTransaction(async () => {
            await repository.persist([createMessage('ping', 1)]);
        });

        expect(await repository.numberOfPendingMessages()).toEqual(1);
    });

    /**
     * Marking messages as consumed joins whatever transaction is active, so a rollback
     * around a relay round undoes the mark even though the messages were already handed
     * to the broker. That errs towards relaying them again, which is the safe direction
     * for an at-least-once outbox, but it does mean consumers must be idempotent.
     */
    test('marking messages as consumed is undone by a rollback around it', async () => {
        await repository.persist([createMessage('ping', 1)]);
        const pending = await collect(repository.retrieveBatch(10));

        await expect(asyncPool.runInTransaction(async () => {
            await repository.markConsumed(pending);

            throw new Error('unrelated failure after the messages were dispatched');
        })).rejects.toThrow('unrelated failure after the messages were dispatched');

        expect(await repository.numberOfConsumedMessages()).toEqual(0);
        expect(await repository.numberOfPendingMessages()).toEqual(1);
    });
});
