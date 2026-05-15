import {createTestClock, secondsToMilliseconds, type TestClock} from '@deltic/clock';
import {ThrottledOutboxRepositoryUsingPg} from './throttled-outbox-repository.js';
import {collect, messageFactory, withoutHeaders} from '@deltic/messaging/helpers';
import {OutboxMessageDispatcher, OutboxRelay, type OutboxRepository} from '@deltic/messaging/outbox';
import {CollectingMessageDispatcher} from '@deltic/messaging/collecting-message-dispatcher';
import {NotifyingOutboxDecoratorUsingPg} from './notifying-outbox-decorator.js';
import {Pool} from 'pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {pgTestCredentials} from '../../../pg-credentials.js';

const clock: TestClock = createTestClock();

interface ExampleStream {
    aggregateRootId: string | number;
    messages: {
        something: {
            id: string;
            additional?: number;
        };
    };
}

const TEST_TABLE_NAME = 'test_throttled_outbox';

let pool: Pool;
let asyncPool: AsyncPgPool;

beforeAll(async () => {
    pool = new Pool(pgTestCredentials);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ${TEST_TABLE_NAME} (
            id BIGSERIAL PRIMARY KEY,
            consumed_initially BOOLEAN NOT NULL DEFAULT FALSE,
            should_dispatch_delayed BOOLEAN NOT NULL DEFAULT FALSE,
            consumed_delayed BOOLEAN NOT NULL DEFAULT FALSE,
            idempotency_key VARCHAR(255) NOT NULL,
            payload JSON NOT NULL,
            delay_until TIMESTAMP WITHOUT TIME ZONE NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS ${TEST_TABLE_NAME}_idempotency_idx ON ${TEST_TABLE_NAME} (idempotency_key)
    `);
});

beforeEach(() => {
    asyncPool = new AsyncPgPool(pool);
});

afterEach(async () => {
    await asyncPool.flush();
});

afterAll(async () => {
    await pool.end();
});

describe.each([
    [
        'using Knex',
        () => {
            return new NotifyingOutboxDecoratorUsingPg(
                asyncPool,
                new ThrottledOutboxRepositoryUsingPg<ExampleStream>(
                    asyncPool,
                    TEST_TABLE_NAME,
                    secondsToMilliseconds(15),
                    message => message.payload.id,
                    clock,
                ),
                TEST_TABLE_NAME,
                {style: 'both', channelName: TEST_TABLE_NAME},
            );
        },
    ],
])('Outbox Repository %s', (_name, provider: () => OutboxRepository<ExampleStream>) => {
    const createMessage = messageFactory<ExampleStream>();
    let repository: OutboxRepository<ExampleStream>;
    let dispatcher: OutboxMessageDispatcher<ExampleStream>;
    let relay: OutboxRelay<ExampleStream>;
    let collectingDispatcher: CollectingMessageDispatcher<ExampleStream>;
    const example1 = createMessage('something', {id: 'one'});
    const example2 = createMessage('something', {id: 'two'});
    const example3 = createMessage('something', {id: 'three'});
    const example4 = createMessage('something', {id: 'four'});
    const examples = [example1, example2, example3, example4] as const;

    beforeEach(async () => {
        repository = provider();
        dispatcher = new OutboxMessageDispatcher(repository);
        collectingDispatcher = new CollectingMessageDispatcher();
        relay = new OutboxRelay(repository, collectingDispatcher);
        await repository.truncate();
    });

    test('dispatching twice deduplicates on the idempotency key', async () => {
        // arrange
        await dispatcher.send(...examples); // once
        await dispatcher.send(...examples); // twice

        // act
        const retrieved = await collect(repository.retrieveBatch(10));

        // assert
        expect(retrieved.map(withoutHeaders)).toEqual([example1, example2, example3, example4]);
    });

    test('dispatching once deduplicates on the idempotency key', async () => {
        // arrange
        await dispatcher.send(...examples, ...examples); // once

        // act
        const retrieved = await collect(repository.retrieveBatch(10));

        // assert
        expect(retrieved.map(withoutHeaders)).toEqual([example1, example2, example3, example4]);
    });

    test('single dispatch deduplication uses the last payload', async () => {
        // arrange
        const messages = Array.from(Array(12).keys()).map(index =>
            createMessage('something', {id: 'same', additional: index}),
        );
        await dispatcher.send(...messages); // once

        // act
        const retrieved = await collect(repository.retrieveBatch(10));

        // assert
        expect(retrieved.map(withoutHeaders)).toEqual([messages.at(11)]);
    });

    test('multi dispatch deduplication uses the last payload', async () => {
        // arrange
        const messages = Array.from(Array(12).keys()).map(index =>
            createMessage('something', {id: 'same', additional: index}),
        );

        for (const message of messages) {
            await dispatcher.send(message);
        }

        // act
        const retrieved = await collect(repository.retrieveBatch(10));

        // assert
        expect(retrieved.map(withoutHeaders)).toEqual([messages.at(11)]);
    });

    test('when the same trigger is only dispatched once, it can be consumed once', async () => {
        const message = createMessage('something', {id: 'same'});
        await dispatcher.send(message);

        // consume initially
        const retrieved = await collect(repository.retrieveBatch(10));
        expect(retrieved.map(withoutHeaders)).toEqual([message]);

        await repository.markConsumed(retrieved);

        // consume potential delayed
        const retrievedLater = await collect(repository.retrieveBatch(10));
        expect(retrievedLater).toHaveLength(0);
    });

    test('when the same trigger is dispatched BEFORE initially consumed, it can only be consumed once', async () => {
        const message = createMessage('something', {id: 'same'});
        await dispatcher.send(message); // once
        await dispatcher.send(message); // twice

        const retrieved = await collect(repository.retrieveBatch(10));
        expect(retrieved.map(withoutHeaders)).toEqual([message]);

        await repository.markConsumed(retrieved);

        const retrievedLater = await collect(repository.retrieveBatch(10));
        expect(retrievedLater).toHaveLength(0);
    });

    test('ensure messages are consumable only once every window, plus the initial consumption', async () => {
        let consumedCount = 0;
        const message = createMessage('something', {id: 'same'});

        for (let i = 1; i <= 65; i++) {
            await dispatcher.send(message); // once
            clock.advance(secondsToMilliseconds(1));

            const retrieved = await collect(repository.retrieveBatch(10));
            consumedCount += retrieved.length;
            await repository.markConsumed(retrieved);
        }

        expect(consumedCount).toEqual(5);
    });

    test('when the same trigger is dispatched AFTER initially consumed, it will also be consumed delayed', async () => {
        /**
         * First, we dispatch the message, consume it initially, and dispatch it again. This should
         * cause our throttle to cause a delayed dispatch after the time-window.
         */
        const message = createMessage('something', {id: 'same'});
        await dispatcher.send(message); // once
        await repository.markConsumed(await collect(repository.retrieveBatch(10)));
        await dispatcher.send(message); // twice
        const lastMessage = createMessage('something', {id: 'same', additional: 10});
        await dispatcher.send(lastMessage); // again

        /**
         * Even though time has passed, we haven't exceeded the window yet, therefor we do not
         * expect the delayed message to be consumed.
         */
        clock.advance(secondsToMilliseconds(14));
        const retrievedWithinWindow = await collect(repository.retrieveBatch(10));
        expect(retrievedWithinWindow).toHaveLength(0);

        /**
         * When we're after the window, we expect a delayed message, which should contain
         * the last payload that was dispatched
         */
        clock.advance(secondsToMilliseconds(2));
        // console.log(await repository.allRecords());
        const retrievedLater = await collect(repository.retrieveBatch(10));
        expect(retrievedLater).toHaveLength(1);
        expect(retrievedLater.map(withoutHeaders)).toEqual([lastMessage]);
        await repository.markConsumed(retrievedLater);

        /**
         * After consuming the delayed message, no messages should be available for consumption
         */
        const retrievedAgainLater = await collect(repository.retrieveBatch(10));
        expect(retrievedAgainLater).toHaveLength(0);
    });

    test('ensure messages are dispatched immediately when the last delay was more than the window ago', async () => {
        const message = createMessage('something', {id: 'same'});
        await dispatcher.send(message); // once
        await repository.markConsumed(await collect(repository.retrieveBatch(10)));
        await dispatcher.send(message); // once

        clock.advance(secondsToMilliseconds(60));

        await dispatcher.send(message); // once
        const retrieved = await collect(repository.retrieveBatch(10));
        await repository.markConsumed(retrieved);

        expect(retrieved.map(withoutHeaders)).toEqual([message]);

        clock.advance(secondsToMilliseconds(20));
        expect(await collect(repository.retrieveBatch(10))).toHaveLength(0);
    });

    test('batch size must limit the amount of messages fetched', async () => {
        // arrange
        await dispatcher.send(...examples); // once
        await dispatcher.send(...examples); // twice

        // act
        const retrieved = await collect(repository.retrieveBatch(1));

        // assert
        expect(retrieved.map(withoutHeaders)).toEqual([example1]);
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
        const messages = Array.from(Array(12).keys()).map(index => createMessage('something', {id: `msg_${index}`}));
        // arrange
        await dispatcher.send(...messages);
        // 0 consumed, 12 pending
        const toBeMarkedAsConsumed = await collect(repository.retrieveBatch(7));
        await repository.markConsumed(toBeMarkedAsConsumed);
        // 7 consumed, 5 pending

        clock.advance(secondsToMilliseconds(31));

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
});
