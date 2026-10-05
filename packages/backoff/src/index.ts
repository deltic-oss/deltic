import {StandardError} from '@deltic/error-standard';

export interface BackOffStrategy {
    /**
     * The delay in milliseconds to apply before the given attempt. A strategy signals exhaustion
     * by throwing `MaxAttemptsExceeded`; a strategy without a maximum never throws, so callers
     * must bound their own retry loops.
     */
    backOff: (attempt: number) => number;
}

export class MaxAttemptsExceeded extends StandardError {
    static atAttempt = (attempt: number) =>
        new MaxAttemptsExceeded('Max attempts exceeded', 'backoff_strategy.error.max_attempts_exceeded', {attempt});
}
