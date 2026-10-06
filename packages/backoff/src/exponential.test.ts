import {ExponentialBackoffStrategy} from './exponential.js';
import {MaxAttemptsExceeded} from './index.js';

describe('exponential backoff', () => {
    test.each([
        [1, 100],
        [2, 200],
        [3, 400],
        [4, 800],
        [5, 1600],
        [6, 3200],
        [7, 6400],
    ])('backs off exponentially', (tryNum, expectedDelay) => {
        const backoffStrategy = new ExponentialBackoffStrategy(100, 25, 250000, 2.0);

        expect(backoffStrategy.backOff(tryNum)).toEqual(expectedDelay);
    });

    test.each([
        [1, 100],
        [2, 200],
        [3, 400],
        [4, 600],
        [5, 600],
        [6, 600],
        [7, 600],
    ])('respects max delay', (tryNum, expectedDelay) => {
        const backoffStrategy = new ExponentialBackoffStrategy(100, 25, 600, 2.0);

        expect(backoffStrategy.backOff(tryNum)).toEqual(expectedDelay);
    });

    test.each([
        [10, 11],
        [10, 15],
        [100, 101],
        [100, 150],
    ])('throws when max tries exceeded', (maxTries, tryNum) => {
        const backoffStrategy = new ExponentialBackoffStrategy(0, maxTries);

        expect(() => backoffStrategy.backOff(tryNum)).toThrow();
    });

    test.each([
        [2, 1.5, 150],
        [3, 1.5, 225],
        [2, 2.5, 250],
        [3, 2.5, 625],
    ])('uses a specified exponent value', (tryNum, exponent, expectedDelay) => {
        const backoffStrategy = new ExponentialBackoffStrategy(100, 100, 1000, exponent);

        expect(backoffStrategy.backOff(tryNum)).toEqual(expectedDelay);
    });

    test('can handle infinite max tries', () => {
        const backoffStrategy = new ExponentialBackoffStrategy(0, -1);

        backoffStrategy.backOff(Number.MAX_SAFE_INTEGER);
    });

    describe('exhausting the attempts', () => {
        test('the attempt that equals the configured maximum is still delayed', () => {
            const backoffStrategy = new ExponentialBackoffStrategy(100, 5, 10000);

            expect(backoffStrategy.backOff(5)).toEqual(1600);
        });

        test('the attempt after the configured maximum reports which attempt was refused', () => {
            const backoffStrategy = new ExponentialBackoffStrategy(100, 5, 10000);

            let refusal: unknown = undefined;

            try {
                backoffStrategy.backOff(6);
            } catch (error) {
                refusal = error;
            }

            expect(refusal).toBeInstanceOf(MaxAttemptsExceeded);
            expect((refusal as MaxAttemptsExceeded).context).toEqual({attempt: 6});
            expect((refusal as MaxAttemptsExceeded).code).toEqual('backoff_strategy.error.max_attempts_exceeded');
        });

        /**
         * This is the shape of a real retry loop: keep asking for a delay until the strategy
         * refuses. It proves the loop terminates, that exactly max-attempts delays are handed
         * out, and how large the total delay budget for a full run is.
         */
        test('a retry loop receives exactly one delay per allowed attempt before it is stopped', () => {
            const backoffStrategy = new ExponentialBackoffStrategy(100, 5, 10000);
            const delays: number[] = [];
            let refusal: unknown = undefined;

            for (let attempt = 1; attempt <= 100; attempt++) {
                try {
                    delays.push(backoffStrategy.backOff(attempt));
                } catch (error) {
                    refusal = error;
                    break;
                }
            }

            expect(delays).toEqual([100, 200, 400, 800, 1600]);
            expect(delays.reduce((total, delay) => total + delay, 0)).toEqual(3100);
            expect(refusal).toBeInstanceOf(MaxAttemptsExceeded);
        });

        test('a maximum of zero refuses the very first attempt', () => {
            const backoffStrategy = new ExponentialBackoffStrategy(100, 0);

            expect(() => backoffStrategy.backOff(1)).toThrow(MaxAttemptsExceeded);
        });
    });

    describe('capping the delay', () => {
        /**
         * A long-lived reconnect loop (see AMQPConnectionProvider in @deltic/messaging) keeps
         * incrementing the attempt for as long as the dependency is unreachable. From attempt 1019
         * onwards the product itself overflows to Infinity, so the cap is the only thing keeping
         * the delay usable.
         */
        test.each([
            [1100],
            [100000],
            [Number.MAX_SAFE_INTEGER],
        ])('the delay stays at the maximum once the exponent overflows', attempt => {
            const backoffStrategy = new ExponentialBackoffStrategy(100, -1, 30000);

            expect(backoffStrategy.backOff(attempt)).toEqual(30000);
        });

        test('the default maximum delay applies when none is configured', () => {
            const backoffStrategy = new ExponentialBackoffStrategy(100, -1);

            expect(backoffStrategy.backOff(1100)).toEqual(2500000);
        });

        test('an attempt count beyond any reasonable retry budget still yields a usable delay', () => {
            const backoffStrategy = new ExponentialBackoffStrategy(100, -1, 30000);
            const delay = backoffStrategy.backOff(Number.MAX_SAFE_INTEGER);

            expect(Number.isFinite(delay)).toBe(true);
            expect(delay).toBeGreaterThan(0);
        });

        test('yields a finite delay for a high attempt count when the initial delay is zero', () => {
            const backoffStrategy = new ExponentialBackoffStrategy(0, -1);

            expect(Number.isFinite(backoffStrategy.backOff(Number.MAX_SAFE_INTEGER))).toBe(true);
        });
    });

    describe('attempt counts a consumer can realistically pass', () => {
        /**
         * DelayedOutboxRepositoryUsingPg in @deltic/messaging derives the attempt from a message
         * header and passes 0 for a message that has never been retried.
         */
        test('an attempt count of zero yields a delay below the initial delay', () => {
            const backoffStrategy = new ExponentialBackoffStrategy(100, 5, 10000);

            expect(backoffStrategy.backOff(0)).toEqual(50);
        });

        test('an attempt count of zero is not counted against the maximum', () => {
            const backoffStrategy = new ExponentialBackoffStrategy(100, 0);

            expect(backoffStrategy.backOff(0)).toEqual(50);
        });

        test('an infinite attempt count is refused when a maximum is configured', () => {
            const backoffStrategy = new ExponentialBackoffStrategy(100, 5, 10000);

            expect(() => backoffStrategy.backOff(Number.POSITIVE_INFINITY)).toThrow(MaxAttemptsExceeded);
        });

        test('an infinite attempt count is capped when attempts are unlimited', () => {
            const backoffStrategy = new ExponentialBackoffStrategy(100, -1, 30000);

            expect(backoffStrategy.backOff(Number.POSITIVE_INFINITY)).toEqual(30000);
        });
    });

    describe('configuring the base', () => {
        test('a base of one turns the strategy into a constant delay', () => {
            const backoffStrategy = new ExponentialBackoffStrategy(100, -1, 10000, 1);

            expect([1, 2, 3, 20].map(attempt => backoffStrategy.backOff(attempt))).toEqual([100, 100, 100, 100]);
        });

        test('a maximum delay below the initial delay clamps every attempt', () => {
            const backoffStrategy = new ExponentialBackoffStrategy(1000, -1, 250);

            expect([1, 2, 3].map(attempt => backoffStrategy.backOff(attempt))).toEqual([250, 250, 250]);
        });
    });
});
