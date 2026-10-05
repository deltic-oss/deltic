import {ExponentialBackoffStrategy} from './exponential.js';
import type {BackOffStrategy} from './index.js';
import {LinearBackoffStrategy} from './linear.js';

/**
 * Both implementations of BackOffStrategy are configured here the way consumers in this repo
 * configure them: a capped exponential strategy for reconnect loops and a plain linear strategy
 * for delayed outbox redelivery. Every case below is a promise the interface makes, so it has to
 * hold for any strategy a consumer plugs in.
 */
describe.each([
    ['exponential', () => new ExponentialBackoffStrategy(100, -1, 30000)],
    ['linear', () => new LinearBackoffStrategy(100)],
] as const)('back-off strategy contract - %s', (_name, factory: () => BackOffStrategy) => {
    test('the first attempt is delayed by a finite, non-negative amount', () => {
        const backoffStrategy = factory();
        const delay = backoffStrategy.backOff(1);

        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
    });

    test('every delay over a full retry run is a finite, non-negative number', () => {
        const backoffStrategy = factory();
        const attempts = Array.from({length: 250}, (_value, index) => index);

        const delays = attempts.map(attempt => backoffStrategy.backOff(attempt));

        expect(delays.every(delay => Number.isFinite(delay) && delay >= 0)).toBe(true);
    });

    test('delays never decrease as the attempts accumulate', () => {
        const backoffStrategy = factory();
        const attempts = Array.from({length: 250}, (_value, index) => index + 1);

        const delays = attempts.map(attempt => backoffStrategy.backOff(attempt));
        const decreases = delays.filter((delay, index) => index > 0 && delay < delays[index - 1]);

        expect(decreases).toEqual([]);
    });

    /**
     * A single strategy instance is shared by every retry loop of its owner.
     * AMQPConnectionProvider in @deltic/messaging, for example, runs one loop per connection
     * identifier against the same strategy, so the delay must depend on the passed attempt only
     * and never on call order.
     */
    test('the delay for an attempt does not depend on what was asked before', () => {
        const backoffStrategy = factory();
        const inIsolation = factory().backOff(4);

        backoffStrategy.backOff(1);
        backoffStrategy.backOff(9);
        backoffStrategy.backOff(200);

        expect(backoffStrategy.backOff(4)).toEqual(inIsolation);
        expect(backoffStrategy.backOff(4)).toEqual(inIsolation);
    });

    /**
     * DelayedOutboxRepositoryUsingPg in @deltic/messaging passes 0 for a message that has never
     * been retried, so 0 has to be an acceptable attempt count for any strategy.
     */
    test('an attempt count of zero yields a finite, non-negative delay', () => {
        const backoffStrategy = factory();
        const delay = backoffStrategy.backOff(0);

        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
    });

    test('an attempt count far beyond any retry budget still yields a finite delay', () => {
        const backoffStrategy = factory();
        const delay = backoffStrategy.backOff(1000000);

        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
    });
});
