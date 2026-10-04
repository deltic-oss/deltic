import {type StaticMutex, UnableToAcquireLock, UnableToReleaseLock} from './index.js';
import {StaticMutexUsingMemory} from './static-memory.js';

let mutex: StaticMutex;

describe.each([['Memory', () => new StaticMutexUsingMemory()]])('Mutex using %s', (_name, factory) => {
    beforeEach(() => {
        mutex = factory();
    });

    test('a lock can be acquired and released', async () => {
        expect.assertions(0);
        await mutex.lock(100);
        await mutex.unlock();
    });

    test('a tried lock can be acquired and released', async () => {
        const locked = await mutex.tryLock();
        await mutex.unlock();

        // assert
        expect(locked).toEqual(true);
    });

    test('a lock cannot be acquired twice', async () => {
        // arrange
        await mutex.lock(100);

        // act
        await expect(mutex.lock(1)).rejects.toThrow(UnableToAcquireLock);

        // cleanup
        await mutex.unlock();
    });

    test('a locked mutex can try but will not acquire a lock', async () => {
        // arrange
        await mutex.lock(100);

        // act
        const locked = await mutex.tryLock();

        // assert
        expect(locked).toBe(false);

        // cleanup
        await mutex.unlock();
    });

    test('released locks can be acquired again', async () => {
        await mutex.lock(100);

        expect(await mutex.tryLock()).toEqual(false);

        await mutex.unlock();

        expect(await mutex.tryLock()).toEqual(true);

        // cleanup
        await mutex.unlock();
    });

    test('locks that are not acquired cannot be released', async () => {
        await expect(mutex.unlock()).rejects.toThrow(UnableToReleaseLock);
    });

    test('a lock without a timeout waits until the holder releases it', async () => {
        // this is how @deltic/async-pg-pool guards its shared connection state
        await mutex.lock();
        let acquired = false;
        const waiter = mutex.lock().then(() => {
            acquired = true;
        });

        expect(acquired).toEqual(false);

        await mutex.unlock();
        await waiter;

        expect(acquired).toEqual(true);

        await mutex.unlock();
    });

    test('the lock is released when the guarded work throws', async () => {
        const workFailure = new Error('the guarded work failed');
        const guardedWork = async () => {
            await mutex.lock();

            try {
                throw workFailure;
            } finally {
                await mutex.unlock();
            }
        };

        await expect(guardedWork()).rejects.toBe(workFailure);

        expect(await mutex.tryLock()).toEqual(true);

        await mutex.unlock();
    });

    test('the lock is granted to exactly one of two concurrent try-lock callers', async () => {
        const attempts = await Promise.all([mutex.tryLock(), mutex.tryLock()]);

        expect(attempts.filter(acquired => acquired)).toHaveLength(1);

        await mutex.unlock();
    });

    test('waiters are served one at a time in the order they queued', async () => {
        const served: number[] = [];
        let concurrentHolders = 0;
        let peakConcurrentHolders = 0;
        await mutex.lock();

        const waiters = [1, 2, 3].map(async position => {
            await mutex.lock(500);
            concurrentHolders++;
            peakConcurrentHolders = Math.max(peakConcurrentHolders, concurrentHolders);
            served.push(position);
            concurrentHolders--;
            await mutex.unlock();
        });

        await mutex.unlock();
        await Promise.all(waiters);

        expect(served).toEqual([1, 2, 3]);
        expect(peakConcurrentHolders).toEqual(1);
    });

    test('releasing the lock twice is reported as a typed failure', async () => {
        await mutex.lock(100);
        await mutex.unlock();

        await expect(mutex.unlock()).rejects.toThrow(UnableToReleaseLock);
    });

    test('a waiter that ran out of time does not take the lock when it is released later', async () => {
        await mutex.lock(100);

        await expect(mutex.lock(5)).rejects.toThrow(UnableToAcquireLock);

        await mutex.unlock();

        expect(await mutex.tryLock()).toEqual(true);

        await mutex.unlock();
    });
});
