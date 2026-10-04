import {setTimeout} from 'node:timers/promises';
import {MutexUsingMemory} from './memory.js';
import {MultiMutex} from './multi.js';
import {type DynamicMutex, UnableToAcquireLock, UnableToReleaseLock} from './index.js';

const lockId = 'lock-id';

interface RecordedCall {
    mutex: string;
    method: 'lock' | 'tryLock' | 'unlock';
    timeout?: number;
}

function recordingMutex(name: string, calls: RecordedCall[]): DynamicMutex<string> {
    return {
        lock: async (_id, timeout) => {
            calls.push({mutex: name, method: 'lock', timeout});
        },
        tryLock: async () => {
            calls.push({mutex: name, method: 'tryLock'});

            return true;
        },
        unlock: async () => {
            calls.push({mutex: name, method: 'unlock'});
        },
    };
}

function unavailableMutex(failure: Error): DynamicMutex<string> {
    return {
        lock: async () => {
            throw failure;
        },
        tryLock: async () => false,
        unlock: async () => {},
    };
}

function mutexThatCannotRelease(failure: Error): DynamicMutex<string> {
    return {
        lock: async () => {},
        tryLock: async () => true,
        unlock: async () => {
            throw failure;
        },
    };
}

describe('MultiMutex', () => {
    let multi: DynamicMutex<string>;
    let first: DynamicMutex<string>;
    let second: DynamicMutex<string>;

    beforeEach(() => {
        multi = new MultiMutex<string>([
            (first = new MutexUsingMemory<string>()),
            (second = new MutexUsingMemory<string>()),
        ]);
    });

    test('locks cannot be acquired when an second mutex is already locked', async () => {
        await second.lock(lockId, 10);

        // cannot lock because the second mutex was already locked
        await expect(multi.lock(lockId, 100)).rejects.toThrow(UnableToAcquireLock);

        // cannot be unlocked because the first mutex was never locked
        await expect(multi.unlock(lockId)).rejects.toThrow(UnableToReleaseLock);
    });

    test('locks cannot be acquired when an first mutex is already locked', async () => {
        await first.lock(lockId, 10);

        // cannot lock because the first mutex was already locked
        await expect(multi.lock(lockId, 100)).rejects.toThrow(UnableToAcquireLock);

        // cannot be unlocked because the second mutex was never locked
        await expect(multi.unlock(lockId)).rejects.toThrow(UnableToReleaseLock);
    });

    test('every mutex is released when a later mutex cannot be acquired', async () => {
        const third = new MutexUsingMemory<string>();
        const withUnavailableMutex = new MultiMutex<string>([
            first,
            unavailableMutex(new Error('the second mutex is unavailable')),
            third,
        ]);

        await expect(withUnavailableMutex.lock(lockId, 100)).rejects.toThrow('the second mutex is unavailable');

        // a partially acquired lock that is not rolled back deadlocks the lock id forever
        expect(await first.tryLock(lockId)).toEqual(true);
        expect(await third.tryLock(lockId)).toEqual(true);

        await first.unlock(lockId);
        await third.unlock(lockId);
    });

    test('mutexes are acquired in order and released in reverse order', async () => {
        const calls: RecordedCall[] = [];
        const ordered = new MultiMutex<string>([recordingMutex('a', calls), recordingMutex('b', calls)]);

        await ordered.lock(lockId, 100);
        await ordered.unlock(lockId);

        expect(calls.map(call => `${call.method}:${call.mutex}`)).toEqual([
            'lock:a',
            'lock:b',
            'unlock:b',
            'unlock:a',
        ]);
    });

    test('the remaining time is passed on to later mutexes', async () => {
        const calls: RecordedCall[] = [];
        const ordered = new MultiMutex<string>([recordingMutex('a', calls), recordingMutex('b', calls)]);

        await ordered.lock(lockId, 1_000);

        const timeoutForSecondMutex = calls[1].timeout!;
        expect(timeoutForSecondMutex).toBeGreaterThan(0);
        expect(timeoutForSecondMutex).toBeLessThanOrEqual(1_000);
    });

    test('no timeout is passed on when no timeout was requested', async () => {
        const calls: RecordedCall[] = [];
        const ordered = new MultiMutex<string>([recordingMutex('a', calls), recordingMutex('b', calls)]);

        await ordered.lock(lockId);

        expect(calls.map(call => call.timeout)).toEqual([undefined, undefined]);
    });

    test('a try-lock releases the mutexes it already acquired when a later mutex refuses', async () => {
        const withUnavailableMutex = new MultiMutex<string>([
            first,
            unavailableMutex(new Error('never acquired')),
            second,
        ]);

        expect(await withUnavailableMutex.tryLock(lockId)).toEqual(false);

        expect(await first.tryLock(lockId)).toEqual(true);
        expect(await second.tryLock(lockId)).toEqual(true);

        await first.unlock(lockId);
        await second.unlock(lockId);
    });

    test('a try-lock treats a failing mutex as a mutex that could not be acquired', async () => {
        const failing: DynamicMutex<string> = {
            lock: async () => {},
            tryLock: async () => {
                throw new Error('the lock backend is unreachable');
            },
            unlock: async () => {},
        };
        const withFailingMutex = new MultiMutex<string>([first, failing]);

        expect(await withFailingMutex.tryLock(lockId)).toEqual(false);
        expect(await first.tryLock(lockId)).toEqual(true);

        await first.unlock(lockId);
    });

    test('a try-lock acquires every mutex or none of them', async () => {
        expect(await multi.tryLock(lockId)).toEqual(true);

        expect(await first.tryLock(lockId)).toEqual(false);
        expect(await second.tryLock(lockId)).toEqual(false);

        await multi.unlock(lockId);

        expect(await first.tryLock(lockId)).toEqual(true);

        await first.unlock(lockId);
    });

    it('releases every mutex even when one of them fails to release', async () => {
        const withFailingRelease = new MultiMutex<string>([
            first,
            mutexThatCannotRelease(new Error('the lock backend is unreachable')),
        ]);
        await withFailingRelease.lock(lockId, 100);

        await withFailingRelease.unlock(lockId).catch(() => undefined);

        const firstWasReleased = await first.tryLock(lockId);

        await first.unlock(lockId).catch(() => undefined);

        expect(firstWasReleased).toEqual(true);
    });

    it('rolls back every acquired mutex when one of the rollbacks fails', async () => {
        const withFailingRollback = new MultiMutex<string>([
            first,
            mutexThatCannotRelease(new Error('the lock backend is unreachable')),
            unavailableMutex(new Error('the third mutex is unavailable')),
        ]);

        await withFailingRollback.lock(lockId, 100).catch(() => undefined);

        const firstWasRolledBack = await first.tryLock(lockId);

        await first.unlock(lockId).catch(() => undefined);

        expect(firstWasRolledBack).toEqual(true);
    });

    it('never passes an exhausted timeout on to a later mutex', async () => {
        const calls: RecordedCall[] = [];
        const slowToAcquire: DynamicMutex<string> = {
            lock: async () => {
                await setTimeout(80);
            },
            tryLock: async () => true,
            unlock: async () => {},
        };
        const withSlowMutex = new MultiMutex<string>([slowToAcquire, recordingMutex('b', calls)]);

        await withSlowMutex.lock(lockId, 20);

        expect(calls[0].timeout).toBeGreaterThan(0);
    });
});
