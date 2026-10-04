import {getEventListeners} from 'node:events';
import {WaitGroup} from './index.js';

type WaitOutcome = 'resolved' | 'pending' | {rejectedWith: unknown};

/**
 * Observes a wait without ever letting it hang the suite. A wait that has not settled
 * within the observation window is reported as pending instead of stalling the test.
 */
async function observe(wait: Promise<void>, withinMs: number = 25): Promise<WaitOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;

    try {
        return await Promise.race<WaitOutcome>([
            wait.then(
                (): WaitOutcome => 'resolved',
                (error: unknown): WaitOutcome => ({rejectedWith: error}),
            ),
            new Promise<WaitOutcome>(resolve => {
                timer = setTimeout(() => resolve('pending'), withinMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Registered waiters are internal state, but retention of them is only observable
 * from the inside, so leak assertions read them through a narrow structural view.
 */
const registeredWaiters = (waitGroup: WaitGroup): number =>
    (waitGroup as unknown as {waiters: unknown[]}).waiters.length;

/**
 * @group deltic
 * @group excluded
 */
describe('WaitGroup', () => {
    test('waiting on no tasks', async () => {
        const wg = new WaitGroup();
        let resolved = false;

        await wg.wait().then(() => (resolved = true));

        expect(resolved).toBe(true);
    });

    test('waiting on one task', async () => {
        let resolved = false;
        const wg = new WaitGroup();
        wg.add();

        setTimeout(() => wg.done(), 10);
        await wg.wait().then(() => (resolved = true));

        expect(resolved).toBe(true);
    });

    test('waiting on multiple tasks', async () => {
        let resolved = false;
        const wg = new WaitGroup();
        wg.add(2);

        setTimeout(() => wg.done(), 10);
        setTimeout(() => wg.done(), 20);
        await wg.wait().then(() => (resolved = true));

        expect(resolved).toBe(true);
    });

    test('cannot be done when not adding', async () => {
        const wg = new WaitGroup();
        await expect(() => wg.done()).toThrow();
    });

    test('cancelling using an abort signal', async () => {
        const wg = new WaitGroup();
        wg.add();
        const controller = new AbortController();
        const abortSignal = controller.signal;

        const promise = wg.wait(-1, {abortSignal});
        controller.abort('this is the reason');

        await expect(promise).rejects.toThrow('this is the reason');
    });

    test('the promise is rejected when not done before the timeout', async () => {
        let firstRejected = false;
        let secondRejected = false;
        let firstResolved = false;
        let secondResolved = false;
        const wg = new WaitGroup();
        wg.add(1);

        setTimeout(() => wg.done(), 40);
        await wg
            .wait(0)
            .then(() => (firstResolved = true))
            .catch(() => (firstRejected = true));

        await wg
            .wait({timeout: 50})
            .then(() => (secondResolved = true))
            .catch(() => (secondRejected = true));

        expect(firstRejected).toBe(true);
        expect(firstResolved).toBe(false);
        expect(secondRejected).toBe(false);
        expect(secondResolved).toBe(true);
    });

    describe('counter transitions', () => {
        test('resolves without yielding to the timer queue when there is no outstanding work', async () => {
            const wg = new WaitGroup();
            const order: string[] = [];

            await Promise.all([
                wg.wait().then(() => order.push('wait')),
                new Promise<void>(resolve => setTimeout(resolve, 0)).then(() => order.push('timer')),
            ]);

            expect(order).toEqual(['wait', 'timer']);
        });

        test('keeps a pending waiter blocked when work is added before the counter drains', async () => {
            const wg = new WaitGroup();
            wg.add();
            const drained = wg.wait();

            wg.add();
            wg.done();

            expect(await observe(drained, 10)).toBe('pending');

            wg.done();

            expect(await observe(drained)).toBe('resolved');
        });

        test('releases every concurrent waiter exactly once', async () => {
            const wg = new WaitGroup();
            wg.add(2);
            const released: number[] = [];
            const waiters = [0, 1, 2].map(index => wg.wait().then(() => released.push(index)));

            wg.done();

            expect(released).toEqual([]);

            wg.done();
            await Promise.all(waiters);

            expect(released).toEqual([0, 1, 2]);

            // A second cycle must not release the already-released waiters again.
            wg.add();
            wg.done();
            await Promise.resolve();

            expect(released).toEqual([0, 1, 2]);
        });

        test('is reusable for a second drain cycle', async () => {
            const wg = new WaitGroup();
            wg.add();
            wg.done();

            expect(await observe(wg.wait())).toBe('resolved');

            wg.add();
            const second = wg.wait();

            expect(await observe(second, 10)).toBe('pending');

            wg.done();

            expect(await observe(second)).toBe('resolved');
        });

        test('throws on a done that follows a completed cycle', async () => {
            const wg = new WaitGroup();
            wg.add();
            wg.done();
            await wg.wait();

            expect(() => wg.done()).toThrow('already at zero');
        });

        test('drains a long-lived work stream and repeated batches during shutdown', async () => {
            // Mirrors the outbox relay runner: a listener holds the group for the
            // lifetime of the runner while batches are added and completed repeatedly.
            const wg = new WaitGroup();
            const shutdownSignal = Promise.withResolvers<void>();
            wg.add();
            const listening = (async () => {
                try {
                    await shutdownSignal.promise;
                } finally {
                    wg.done();
                }
            })();

            const relayBatch = async () => {
                wg.add();

                try {
                    await Promise.resolve();
                } finally {
                    wg.done();
                }
            };

            await relayBatch();
            await relayBatch();

            const drained = wg.wait();

            expect(await observe(drained, 10)).toBe('pending');

            shutdownSignal.resolve();
            await listening;

            expect(await observe(drained)).toBe('resolved');
        });
    });

    describe('failure paths', () => {
        test('releases an in-flight waiter when the remaining work rejects', async () => {
            const wg = new WaitGroup();
            wg.add();
            const work = Promise.reject(new Error('relay failed')).finally(() => wg.done());
            const drained = wg.wait();

            await expect(work).rejects.toThrow('relay failed');

            expect(await observe(drained)).toBe('resolved');
        });

        test('releases an in-flight waiter when the remaining work throws synchronously', async () => {
            const wg = new WaitGroup();
            wg.add();
            const drained = wg.wait();

            expect(() => {
                try {
                    throw new Error('processor failed');
                } finally {
                    wg.done();
                }
            }).toThrow('processor failed');

            expect(await observe(drained)).toBe('resolved');
        });

        test('stays usable after a wait timed out', async () => {
            const wg = new WaitGroup();
            wg.add();

            await expect(wg.wait({timeout: 5})).rejects.toThrow();

            wg.done();
            wg.add();
            const second = wg.wait();
            wg.done();

            expect(await observe(second)).toBe('resolved');
        });
    });

    describe('timeout and abort handling', () => {
        test('rejects with a timeout reason when the work outlives the timeout', async () => {
            const wg = new WaitGroup();
            wg.add();

            const reason = await wg.wait({timeout: 5}).then(
                () => undefined,
                (error: unknown) => error,
            );

            expect(reason).toBeInstanceOf(DOMException);
            expect(`${reason}`).toContain('TimeoutError');
        });

        test('prefers the caller abort reason when both a timeout and an abort signal are given', async () => {
            const wg = new WaitGroup();
            wg.add();
            const controller = new AbortController();
            const drained = wg.wait({timeout: 10_000, abortSignal: controller.signal});

            controller.abort(new Error('shutting down'));

            await expect(drained).rejects.toThrow('shutting down');
        });

        test('rejects immediately when the abort signal already aborted', async () => {
            const wg = new WaitGroup();
            wg.add();
            const controller = new AbortController();
            controller.abort(new Error('deadline exceeded'));

            await expect(wg.wait({abortSignal: controller.signal})).rejects.toThrow('deadline exceeded');
        });

        test('rejects on an already aborted signal even without outstanding work', async () => {
            // The abort check runs before the empty-group fast path, so an expired
            // deadline rejects a drain that had nothing left to wait for.
            const wg = new WaitGroup();
            const controller = new AbortController();
            controller.abort(new Error('deadline exceeded'));

            await expect(wg.wait({abortSignal: controller.signal})).rejects.toThrow('deadline exceeded');
        });

        test('ignores an abort that arrives after the wait resolved', async () => {
            const wg = new WaitGroup();
            wg.add();
            const controller = new AbortController();
            const drained = wg.wait({abortSignal: controller.signal});
            wg.done();

            await expect(drained).resolves.toBeUndefined();

            controller.abort(new Error('too late'));
            await Promise.resolve();

            await expect(drained).resolves.toBeUndefined();
        });

        test('waits indefinitely when the timeout argument is undefined', async () => {
            // AMQPChannelPool.close() forwards an optional timeout straight into wait().
            const wg = new WaitGroup();
            wg.add();
            const closing = wg.wait(undefined);

            expect(await observe(closing, 10)).toBe('pending');

            wg.done();

            expect(await observe(closing)).toBe('resolved');
        });

        test('treats a negative timeout as no timeout', async () => {
            const wg = new WaitGroup();
            wg.add();
            const drained = wg.wait({timeout: -1});

            expect(await observe(drained, 10)).toBe('pending');

            wg.done();

            expect(await observe(drained)).toBe('resolved');
        });

        test('treats an infinite timeout as no timeout', async () => {
            const wg = new WaitGroup();
            wg.add();

            expect(await observe(wg.wait(Infinity), 10)).toBe('pending');
        });

        test('rounds a fractional timeout up instead of rejecting it', async () => {
            const wg = new WaitGroup();
            wg.add();

            // A fractional deadline is a usable deadline; it used to surface as Node's internal
            // RangeError about a parameter the caller never wrote.
            await expect(wg.wait(1.5)).rejects.toThrow('The operation was aborted due to timeout');
        });

        test('treats a timeout that is not a number as no timeout', async () => {
            const wg = new WaitGroup();
            wg.add();

            expect(await observe(wg.wait(Number.NaN), 15)).toBe('pending');

            const idle = new WaitGroup();

            await expect(idle.wait(Number.NaN)).resolves.toBeUndefined();
        });
    });

    describe('add argument handling', () => {
        test('ignores an add of zero', async () => {
            const wg = new WaitGroup();
            wg.add(0);

            expect(await observe(wg.wait())).toBe('resolved');
            expect(() => wg.done()).toThrow('already at zero');
        });

        test('refuses a count that would drive the counter below zero', () => {
            const wg = new WaitGroup();

            expect(() => wg.add(-1)).toThrow();
        });

        test('a refused negative count leaves the group usable', async () => {
            const wg = new WaitGroup();

            expect(() => wg.add(-1)).toThrow('non-negative integer');

            // The refused count changed nothing: there is no outstanding work.
            await expect(wg.wait()).resolves.toBeUndefined();
            expect(() => wg.done()).toThrow('already at zero');
        });

        test('a refused non-numeric count leaves the group usable', async () => {
            const wg = new WaitGroup();

            expect(() => wg.add(Number.NaN)).toThrow('non-negative integer');

            await expect(wg.wait()).resolves.toBeUndefined();
        });
    });

    describe('resource cleanup', () => {
        test('forgets a waiter whose wait timed out', async () => {
            const wg = new WaitGroup();
            wg.add();

            for (let attempt = 0; attempt < 3; attempt++) {
                await expect(wg.wait({timeout: 5})).rejects.toThrow();
            }

            expect(registeredWaiters(wg)).toBe(0);
        });

        test('removes its abort listener once the wait resolves', async () => {
            const wg = new WaitGroup();
            const controller = new AbortController();

            for (let cycle = 0; cycle < 3; cycle++) {
                wg.add();
                const drained = wg.wait({abortSignal: controller.signal});
                wg.done();
                await drained;
            }

            expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        });
    });
});
