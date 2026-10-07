import {LinearBackoffStrategy} from '@deltic/backoff/linear';
import {ExponentialBackoffStrategy} from '@deltic/backoff/exponential';
import {createTestClock, type TestClock} from '@deltic/clock';
import {isUnrecoverableError} from '@deltic/error-standard';
import type {StreamDefinition} from '../index.js';
import {AMQPChannelPool} from './channel-pool.js';
import {
    AMQPConnectionProvider,
    ConnectionShuttingDown,
    UnableToEstablishConnection,
    UnableToHealAMQPConnection,
} from './connection-provider.js';
import {AMQPMessageDispatcher} from './message-dispatcher.js';
import {AMQPMessageRelay} from './message-relay.js';

/**
 * Uses a valid but unreachable port to trigger connection failures
 * without causing Node.js ERR_SOCKET_BAD_PORT errors.
 */
const unreachableUrl = 'amqp://unused:unused@localhost:19999';

/**
 * Use a fast backoff for unit tests to avoid unnecessary waiting.
 */
const fastBackoff = new LinearBackoffStrategy(10);

describe('AMQPConnectionProvider', () => {
    test('requesting a connection after close throws ConnectionShuttingDown', async () => {
        const provider = new AMQPConnectionProvider(unreachableUrl);

        await provider.close();

        await expect(provider.connection()).rejects.toThrow(ConnectionShuttingDown);
    });

    test('a failed connection attempt allows retrying with the same identifier', async () => {
        let callCount = 0;
        const provider = new AMQPConnectionProvider(() => {
            callCount++;
            return [unreachableUrl];
        }, {backoff: fastBackoff});

        // First attempt should fail
        await expect(provider.connection('test', 150)).rejects.toThrow(UnableToEstablishConnection);

        // The waiter should be cleaned up, so a second call should try again (not return a stale rejection)
        await expect(provider.connection('test', 150)).rejects.toThrow(UnableToEstablishConnection);

        // The factory was called more than once, proving it retried
        expect(callCount).toBeGreaterThan(1);

        await provider.close();
    });

    /**
     * A bounded strategy such as ExponentialBackoffStrategy throws MaxAttemptsExceeded
     * once its attempt ceiling is passed. That used to escape the retry loop without
     * settling the promise handed to the caller: connection() never resolved or rejected,
     * and close() — which waits for the pending waiters — never returned either.
     */
    test('a backoff strategy that gives up rejects the pending connection', async () => {
        const provider = new AMQPConnectionProvider(unreachableUrl, {
            backoff: new ExponentialBackoffStrategy(1, 1),
        });

        const error = await provider.connection('bounded').catch((error: unknown) => error);

        expect(error).toBeInstanceOf(UnableToHealAMQPConnection);
        expect(isUnrecoverableError(error)).toBe(true);
        await provider.close();
    });

    test('closing during an active connection attempt causes it to reject', async () => {
        const provider = new AMQPConnectionProvider(unreachableUrl);

        // Start a connection attempt without timeout - it will loop until closed
        const connectionPromise = provider.connection('no-timeout');

        // Give it a moment to start trying
        await new Promise(resolve => setTimeout(resolve, 300));

        // Closing should cause the loop to exit
        await provider.close();

        await expect(connectionPromise).rejects.toThrow(UnableToEstablishConnection);
    });
});

interface HealingStream extends StreamDefinition {
    aggregateRootId: string;
    messages: {
        something: {name: string};
    };
}

/**
 * The URL is resolved once per connect attempt, which makes attempts countable without reaching
 * into the provider, and is the one place a test can put its hands on the clock between two
 * attempts. Advancing it there turns the healing window into an exact number of attempts instead
 * of a number of wall-clock milliseconds.
 */
function countedAttempts(clock: TestClock = createTestClock(0), perAttempt: number = 0): {
    url: () => string;
    count: () => number;
} {
    let count = 0;

    return {
        url: () => {
            count++;
            clock.advance(perAttempt);

            return unreachableUrl;
        },
        count: () => count,
    };
}

const noDelay = new LinearBackoffStrategy(0);

describe('AMQP connection healing', () => {
    test('an unreachable broker is retried until the healing window runs out', async () => {
        const clock = createTestClock(0);
        const attempts = countedAttempts(clock, 100);
        const provider = new AMQPConnectionProvider(attempts.url, {healingTimeout: 250, backoff: noDelay, clock});

        await expect(provider.connection()).rejects.toThrow(UnableToHealAMQPConnection);

        // The window opens on the first failure, so it runs out on the attempt 250ms after it.
        expect(attempts.count()).toBe(4);
        await provider.close();
    });

    test('a healing window that has run out is not carried into a later attempt', async () => {
        const clock = createTestClock(0);
        const attempts = countedAttempts(clock, 100);
        const provider = new AMQPConnectionProvider(attempts.url, {healingTimeout: 250, backoff: noDelay, clock});
        await expect(provider.connection()).rejects.toThrow(UnableToHealAMQPConnection);
        const attemptsForTheFirstWindow = attempts.count();

        clock.advance(3_600_000);
        await expect(provider.connection()).rejects.toThrow(UnableToHealAMQPConnection);

        expect(attempts.count() - attemptsForTheFirstWindow).toBe(attemptsForTheFirstWindow);
        await provider.close();
    });

    test('giving up on healing produces an error the process is meant to end on', async () => {
        const provider = new AMQPConnectionProvider(unreachableUrl, {healingTimeout: 0});

        const error = await provider.connection().catch((error: unknown) => error);

        expect(error).toBeInstanceOf(UnableToHealAMQPConnection);
        expect(isUnrecoverableError(error)).toBe(true);
        await provider.close();
    });

    test('a failed connect leaves the provider willing to try again', async () => {
        const attempts = countedAttempts();
        const provider = new AMQPConnectionProvider(attempts.url, {healingTimeout: 0});

        await expect(provider.connection()).rejects.toThrow(UnableToHealAMQPConnection);
        await expect(provider.connection()).rejects.toThrow(UnableToHealAMQPConnection);

        expect(attempts.count()).toBe(2);
        await provider.close();
    });

    test('callers that arrive during a failing connect share its outcome without an unhandled rejection', async () => {
        const provider = new AMQPConnectionProvider(unreachableUrl, {healingTimeout: 50, backoff: new LinearBackoffStrategy(10)});

        const outcomes = await Promise.allSettled([provider.connection(), provider.connection()]);

        expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected']);
        expect(outcomes.map(outcome => outcome.status === 'rejected' && outcome.reason instanceof UnableToHealAMQPConnection))
            .toEqual([true, true]);
        await provider.close();
    });

    test('a caller that sets its own timeout gets an ordinary failure, not an unrecoverable one', async () => {
        const provider = new AMQPConnectionProvider(unreachableUrl, {healingTimeout: 60_000, backoff: new LinearBackoffStrategy(25)});

        const error = await provider.connection(undefined, 50).catch((error: unknown) => error);

        expect(error).toBeInstanceOf(UnableToEstablishConnection);
        expect(isUnrecoverableError(error)).toBe(false);
        await provider.close();
    });

    test('a channel request fails with the unrecoverable error when the connection cannot heal', async () => {
        const provider = new AMQPConnectionProvider(unreachableUrl, {healingTimeout: 0});
        const channelPool = new AMQPChannelPool(provider);

        await expect(channelPool.channel()).rejects.toThrow(UnableToHealAMQPConnection);
        await provider.close();
    });

    test('a dispatcher spends no further tries once the broker is reported unreachable', async () => {
        const attempts = countedAttempts();
        const provider = new AMQPConnectionProvider(attempts.url, {healingTimeout: 0});
        const channelPool = new AMQPChannelPool(provider);
        const dispatcher = new AMQPMessageDispatcher<HealingStream>(channelPool, {exchange: 'healing', maxTries: 5});

        const sending = dispatcher.send({type: 'something', payload: {name: 'Frank'}, headers: {}});

        await expect(sending).rejects.toThrow(UnableToHealAMQPConnection);
        expect(attempts.count()).toBe(1);
        await provider.close();
    });

    test('a relay that cannot reach the broker ends its run instead of retrying forever', async () => {
        const provider = new AMQPConnectionProvider(unreachableUrl, {healingTimeout: 0});
        const channelPool = new AMQPChannelPool(provider);
        const relay = new AMQPMessageRelay<HealingStream>(
            channelPool,
            {consume: async () => undefined},
            {queueNames: ['healing']},
        );

        await expect(relay.start()).rejects.toThrow(UnableToHealAMQPConnection);
        await relay.stop();
        await provider.close();
    });
});
