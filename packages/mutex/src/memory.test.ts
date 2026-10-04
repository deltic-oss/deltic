import {setTimeout} from 'node:timers/promises';
import {UnableToAcquireLock, UnableToReleaseLock} from './index.js';
import {MutexUsingMemory} from './memory.js';

const lockId = 'memory-lock-id';

describe('MutexUsingMemory', () => {
    let mutex: MutexUsingMemory<string>;

    beforeEach(() => {
        mutex = new MutexUsingMemory<string>();
    });

    test('a waiter without a timeout waits until the holder releases the lock', async () => {
        await mutex.lock(lockId);
        let acquired = false;
        const waiter = mutex.lock(lockId).then(() => {
            acquired = true;
        });

        expect(acquired).toEqual(false);

        await mutex.unlock(lockId);
        await waiter;

        expect(acquired).toEqual(true);

        await mutex.unlock(lockId);
    });

    test('waiters are served in the order they queued', async () => {
        const served: number[] = [];
        await mutex.lock(lockId);

        const waiters = [1, 2, 3].map(async position => {
            await mutex.lock(lockId, 200);
            served.push(position);
            await mutex.unlock(lockId);
        });

        await mutex.unlock(lockId);
        await Promise.all(waiters);

        expect(served).toEqual([1, 2, 3]);
    });

    test('only one waiter at a time is granted the lock', async () => {
        const holders: number[] = [];
        let concurrentHolders = 0;
        let peakConcurrentHolders = 0;
        await mutex.lock(lockId);

        const waiters = [1, 2, 3, 4].map(async position => {
            await mutex.lock(lockId, 500);
            concurrentHolders++;
            peakConcurrentHolders = Math.max(peakConcurrentHolders, concurrentHolders);
            holders.push(position);
            await setTimeout(0);
            concurrentHolders--;
            await mutex.unlock(lockId);
        });

        await mutex.unlock(lockId);
        await Promise.all(waiters);

        expect(peakConcurrentHolders).toEqual(1);
        expect(holders).toHaveLength(4);
    });

    test('a waiter that ran out of time is rejected with a typed error', async () => {
        await mutex.lock(lockId);

        await expect(mutex.lock(lockId, 5)).rejects.toThrow(UnableToAcquireLock);

        await mutex.unlock(lockId);
    });

    test('a waiter that ran out of time does not take the lock when it is released later', async () => {
        await mutex.lock(lockId);
        await expect(mutex.lock(lockId, 5)).rejects.toThrow(UnableToAcquireLock);

        await mutex.unlock(lockId);

        expect(await mutex.tryLock(lockId)).toEqual(true);

        await mutex.unlock(lockId);
    });

    test('a lock can be re-used for many acquire and release cycles', async () => {
        for (let cycle = 0; cycle < 25; cycle++) {
            await mutex.lock(lockId, 50);
            await mutex.unlock(lockId);
        }

        expect(await mutex.tryLock(lockId)).toEqual(true);

        await mutex.unlock(lockId);
    });

    test('releasing a lock twice is reported as a typed failure', async () => {
        await mutex.lock(lockId, 50);
        await mutex.unlock(lockId);

        await expect(mutex.unlock(lockId)).rejects.toThrow(UnableToReleaseLock);
    });

    it('frees a lock id when its holder releases it while another lock id has waiters', async () => {
        await mutex.lock('one');
        await mutex.lock('two');
        const waiterForTwo = mutex.lock('two', 50).then(
            () => {},
            () => {},
        );

        await mutex.unlock('one');
        await waiterForTwo;

        const oneIsFreeAgain = await mutex.tryLock('one');

        // cleanup before asserting so a failure cannot leak held locks
        await mutex.unlock('one').catch(() => {});
        await mutex.unlock('two').catch(() => {});

        expect(oneIsFreeAgain).toEqual(true);
    });

    it('keeps mutual exclusion per lock id while several lock ids are contended', async () => {
        const lockIds = ['stream-a', 'stream-b'];
        const activePerLockId = new Map<string, number>(lockIds.map(id => [id, 0]));
        let peakConcurrentHoldersOfOneLockId = 0;

        const work = lockIds.flatMap(id =>
            [1, 2, 3].map(async () => {
                await mutex.lock(id, 500).catch(() => undefined);
                const active = (activePerLockId.get(id) ?? 0) + 1;
                activePerLockId.set(id, active);
                peakConcurrentHoldersOfOneLockId = Math.max(peakConcurrentHoldersOfOneLockId, active);
                await setTimeout(1);
                activePerLockId.set(id, active - 1);
                await mutex.unlock(id).catch(() => undefined);
            }),
        );

        await Promise.all(work);

        for (const id of lockIds) {
            await mutex.unlock(id).catch(() => undefined);
        }

        expect(peakConcurrentHoldersOfOneLockId).toEqual(1);
    });
});
