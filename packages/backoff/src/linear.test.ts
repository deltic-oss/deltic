import {LinearBackoffStrategy} from './linear.js';

describe('linear backoff', () => {
    test.each([
        [1, 100],
        [2, 200],
        [3, 300],
        [4, 400],
        [5, 500],
        [6, 600],
        [7, 700],
    ])('backs off linearly', (tryNum, expectedDelay) => {
        const backoffStrategy = new LinearBackoffStrategy(100);

        expect(backoffStrategy.backOff(tryNum)).toEqual(expectedDelay);
    });

    /**
     * DelayedOutboxRepositoryUsingPg in @deltic/messaging passes 0 for a message that has never
     * been retried and relies on the resulting delay being zero to make that message immediately
     * consumable.
     */
    test('an attempt count of zero yields no delay at all', () => {
        const backoffStrategy = new LinearBackoffStrategy(1000);

        expect(backoffStrategy.backOff(0)).toEqual(0);
    });

    test('an increment of zero removes the delay entirely', () => {
        const backoffStrategy = new LinearBackoffStrategy(0);

        expect([0, 1, 2, 500].map(attempt => backoffStrategy.backOff(attempt))).toEqual([0, 0, 0, 0]);
    });

    /**
     * The linear strategy has neither a maximum number of attempts nor a maximum delay, so it
     * never stops a retry loop and its delay keeps growing. AMQPConnectionProvider in
     * @deltic/messaging defaults to this strategy and therefore has to bound its own loop with a
     * timeout. Anything that relies on the strategy to stop retrying would loop forever.
     */
    test('a retry loop is never stopped by the strategy, and the delay keeps growing', () => {
        const backoffStrategy = new LinearBackoffStrategy(100);
        const delays: number[] = [];

        for (let attempt = 1; attempt <= 1000; attempt++) {
            delays.push(backoffStrategy.backOff(attempt));
        }

        expect(delays).toHaveLength(1000);
        expect(delays.at(-1)).toEqual(100000);
        expect(delays.every(delay => Number.isFinite(delay) && delay >= 0)).toBe(true);
    });

    test('the delay grows without an upper bound', () => {
        const backoffStrategy = new LinearBackoffStrategy(100);

        expect(backoffStrategy.backOff(1000000)).toEqual(100000000);
    });
});
