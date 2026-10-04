export type Waiter = () => void;

export type WaitOptions = {
    timeout?: number;
    abortSignal?: AbortSignal;
};

/**
 * The longest timeout a timer can express. Anything above it is indistinguishable from "no
 * deadline" for a running process, and used to overflow into firing after one millisecond.
 */
const longestExpressibleTimeout = 2 ** 31 - 1;

export class WaitGroup {
    private counter: number = 0;
    private waiters: Waiter[] = [];

    public add(i: number = 1): void {
        // Refused rather than stored: a negative or unusable count makes the counter unable to
        // ever reach zero again, which turns every later wait() into a silent, permanent hang —
        // and puts done() misuse reporting out of reach.
        if (!Number.isInteger(i) || i < 0) {
            throw new Error(`Unexpected WaitGroup.add count, expected a non-negative integer, got: ${i}`);
        }

        this.counter += i;
    }

    public done(): void {
        if (this.counter === 0) {
            throw new Error('Unexpected WaitGroup.done, already at zero.');
        }

        this.counter -= 1;

        if (this.counter === 0) {
            const waiters = this.waiters;
            this.waiters = [];
            waiters.forEach(waiter => waiter());
        }
    }

    public async wait(options?: WaitOptions): Promise<void>;
    public async wait(timeout?: number, defaults?: WaitOptions): Promise<void>;
    public async wait(options: WaitOptions | number = {}, defaults: WaitOptions = {}): Promise<void> {
        const opts = resolveOptions(
            typeof options === 'number' ? {...defaults, timeout: options} : {...defaults, ...options},
        );

        if (this.counter === 0) {
            return Promise.resolve();
        }

        const {resolve, promise, reject} = Promise.withResolvers<void>();
        const abortSignal = opts.abortSignal;

        const settle: Waiter = () => {
            // A settled wait must leave nothing behind: the abort listener would otherwise pile up
            // on a long-lived signal, one per completed wait, without any warning from Node.
            abortSignal?.removeEventListener('abort', onAbort);
            resolve();
        };

        const onAbort = () => {
            // Same in the other direction: a waiter whose wait ended must not stay in the list,
            // or a group whose counter rarely reaches zero grows by one entry per timed-out wait.
            const index = this.waiters.indexOf(settle);

            if (index >= 0) {
                this.waiters.splice(index, 1);
            }

            reject(abortSignal!.reason);
        };

        this.waiters.push(settle);
        abortSignal?.addEventListener('abort', onAbort, {once: true});

        return promise;
    }
}

function resolveOptions(options: WaitOptions): WaitOptions {
    // A timeout only counts when it can mean one: negative, NaN and Infinity all translate to
    // "no deadline" instead of reaching the timer, which would either reject with an internal
    // range error naming a parameter the caller never wrote, or overflow into firing immediately.
    // Zero stays a deadline — an instant one — because waiting no time at all is a real request.
    const timeout = options.timeout !== undefined
        && Number.isFinite(options.timeout)
        && options.timeout >= 0
        ? Math.min(Math.ceil(options.timeout), longestExpressibleTimeout)
        : undefined;

    let abortSignal: AbortSignal | undefined = options.abortSignal;

    if (timeout !== undefined) {
        abortSignal = options.abortSignal
            ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(timeout)])
            : AbortSignal.timeout(timeout);
    }

    if (abortSignal?.aborted) {
        throw abortSignal.reason;
    }

    return {...options, timeout, abortSignal};
}
