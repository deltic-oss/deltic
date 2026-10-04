import {ExponentialBackoffStrategy} from './exponential.js';
import * as packageRoot from './index.js';
import {MaxAttemptsExceeded} from './index.js';

describe('max attempts exceeded', () => {
    test('carries the refused attempt as context for logging and metrics', () => {
        const error = MaxAttemptsExceeded.atAttempt(7);

        expect(error.message).toEqual('Max attempts exceeded');
        expect(error.code).toEqual('backoff_strategy.error.max_attempts_exceeded');
        expect(error.context).toEqual({attempt: 7});
    });

    test('is an error a retry loop can catch and tell apart from the failure it was retrying', () => {
        const backoffStrategy = new ExponentialBackoffStrategy(100, 1);
        const errors: unknown[] = [];

        for (const attempt of [1, 2]) {
            try {
                backoffStrategy.backOff(attempt);
            } catch (error) {
                errors.push(error);
            }
        }

        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(MaxAttemptsExceeded);
        expect(errors[0]).toBeInstanceOf(Error);
    });

    test('does not share its context object between instances', () => {
        const first = MaxAttemptsExceeded.atAttempt(1);
        const second = MaxAttemptsExceeded.atAttempt(2);

        expect(first.context).not.toBe(second.context);
        expect(first.context).toEqual({attempt: 1});
    });
});

describe('package entry points', () => {
    test('the package root exposes the retry contract and its exhaustion error', () => {
        expect(Object.keys(packageRoot)).toContain('MaxAttemptsExceeded');
    });

    test('the strategies live behind sub-path exports, keeping the root dependency-free', () => {
        // The README imports them from @deltic/backoff/exponential and /linear; the root
        // deliberately exports only the contract and the error.
        expect(Object.keys(packageRoot)).not.toContain('ExponentialBackoffStrategy');
        expect(Object.keys(packageRoot)).not.toContain('LinearBackoffStrategy');
    });
});
