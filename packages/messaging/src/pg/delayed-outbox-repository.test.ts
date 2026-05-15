import {createTestClock} from '@deltic/clock';
import {DelayedOutboxRepositoryUsingPg} from './delayed-outbox-repository.js';
import {collect, messageFactory} from '@deltic/messaging/helpers';
import {Pool} from 'pg';
import {pgTestCredentials} from '../../../pg-credentials.js';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import type {AnyMessageFrom} from '@deltic/messaging';
import {LinearBackoffStrategy} from '@deltic/backoff/linear';
import {CollectingMessageDispatcher} from '@deltic/messaging/collecting-message-dispatcher';
import {OutboxMessageDispatcher, OutboxRelay} from '@deltic/messaging/outbox';

const testClock = createTestClock();

interface ExampleStream {
    aggregateRootId: string | number;
    messages: {
        ping: number;
        pong: number;
    };
}

const createMessage = messageFactory<ExampleStream>();

describe('Delayed Outbox Repository', () => {
    let pgPool: Pool;
    let asyncPool: AsyncPgPool;

    beforeAll(async () => {
        pgPool = new Pool(pgTestCredentials);

        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS delayed_outbox (
                id BIGSERIAL PRIMARY KEY,
                consumed BOOLEAN NOT NULL,
                payload JSON NOT NULL,
                delay_until TIMESTAMP WITHOUT TIME ZONE
            );
        `);
    });

    afterAll(async () => {
        await pgPool.end();
    });

    let repository: DelayedOutboxRepositoryUsingPg<ExampleStream>;
    let dispatcher: OutboxMessageDispatcher<ExampleStream>;
    let relay: OutboxRelay<ExampleStream>;
    let collectingDispatcher: CollectingMessageDispatcher<ExampleStream>;
    const example1 = createMessage('ping', 1);
    const example2 = createMessage('pong', 2, {attempt: 1});
    const example3 = createMessage('ping', 3, {attempt: 2});
    const example4 = createMessage('pong', 3, {attempt: 3});
    const examples = [example1, example2, example3, example4];
    const keepOnlyAttemptHeader = <M extends AnyMessageFrom<ExampleStream>>(message: M): M => ({
        ...message,
        headers: {
            attempt: message.headers['attempt'],
        },
    });
    const messageAtAttempt = <M extends AnyMessageFrom<ExampleStream>>(message: M, attempt: number): M => ({
        ...message,
        headers: {attempt},
    });

    beforeEach(() => {
        asyncPool = new AsyncPgPool(pgPool);
        repository = new DelayedOutboxRepositoryUsingPg(
            asyncPool,
            'delayed_outbox',
            new LinearBackoffStrategy(1000),
            testClock,
        );
        dispatcher = new OutboxMessageDispatcher(repository);
        collectingDispatcher = new CollectingMessageDispatcher();
        relay = new OutboxRelay(repository, collectingDispatcher);
    });
    afterEach(async () => {
        await repository.truncate();
        await asyncPool.flush();
    });

    test('dispatching messages end up in the outbox repository, and respects message delays', async () => {
        // arrange
        await dispatcher.send(...examples);

        // message without attempt is immediately consumable
        const immediately = await collect(repository.retrieveBatch(10));
        expect(immediately.length).toEqual(1);

        // after 1000 the second message is available
        testClock.advance(1000);
        const firstBatch = await collect(repository.retrieveBatch(10));
        expect(firstBatch.length).toEqual(2);

        // after another 1000 the third message is also available
        testClock.advance(1000);
        const secondBatch = await collect(repository.retrieveBatch(10));
        expect(secondBatch.length).toEqual(3);

        // after another 1000 all messages are available
        testClock.advance(1000);
        const finalBatch = await collect(repository.retrieveBatch(10));
        expect(finalBatch.length).toEqual(4);
    });

    test('batch size must limit the amount of messages fetched', async () => {
        // arrange
        await dispatcher.send(...examples);
        testClock.advance(10000);

        // act
        const retrieved = await collect(repository.retrieveBatch(2));

        // assert
        expect(retrieved.map(keepOnlyAttemptHeader)).toEqual([
            messageAtAttempt(example1, 1),
            messageAtAttempt(example2, 2),
        ]);
    });

    test('consumed messages are not retrieved', async () => {
        // arrange
        await dispatcher.send(...examples);
        testClock.advance(10000);

        // act
        const toBeMarkedAsConsumed = await collect(repository.retrieveBatch(2));
        await repository.markConsumed(toBeMarkedAsConsumed);
        const retrieved = await collect(repository.retrieveBatch(10));

        // assert
        expect(retrieved.map(keepOnlyAttemptHeader)).toEqual([
            messageAtAttempt(example3, 3),
            messageAtAttempt(example4, 4),
        ]);
    });

    test('relayed messages are dispatched onto another dispatcher', async () => {
        // arrange
        await dispatcher.send(...examples);
        testClock.advance(10000);

        // act
        await relay.relayBatch(3, 2);

        // assert
        expect(collectingDispatcher.dispatchCount).toEqual(2);
        expect(collectingDispatcher.producedMessages().map(keepOnlyAttemptHeader)).toEqual([
            messageAtAttempt(example1, 1),
            messageAtAttempt(example2, 2),
            messageAtAttempt(example3, 3),
        ]);
    });

    test('it can give counts of consumed and pending messages', async () => {
        // arrange
        await dispatcher.send(...examples);
        testClock.advance(10000);
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
        testClock.advance(10000);
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
});
