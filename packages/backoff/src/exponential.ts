import {type BackOffStrategy, MaxAttemptsExceeded} from './index.js';

export class ExponentialBackoffStrategy implements BackOffStrategy {
    constructor(
        private readonly initialDelayMs: number,
        private readonly maxAttempts: number,
        private readonly maxDelay: number = 2500000,
        private readonly base = 2.0,
    ) {}

    backOff(attempt: number): number {
        if (this.maxAttempts !== -1 && attempt > this.maxAttempts) {
            throw MaxAttemptsExceeded.atAttempt(attempt);
        }

        // Once the exponent overflows to Infinity, a zero initial delay would yield 0 * Infinity = NaN.
        if (this.initialDelayMs === 0) {
            return 0;
        }

        return Math.min(this.maxDelay, this.initialDelayMs * this.base ** (attempt - 1));
    }
}
