import {type LockValue, type DynamicMutex, UnableToReleaseLock} from './index.js';

export class MultiMutex<LockID extends LockValue> implements DynamicMutex<LockID> {
    constructor(private readonly mutexes: DynamicMutex<LockID>[]) {}

    async lock(id: LockID, timeout?: number): Promise<void> {
        const start = process.hrtime.bigint();
        let timeLeft = timeout;
        const useTimeout = timeLeft !== undefined;
        const lockedMutexes: DynamicMutex<LockID>[] = [];

        for (const mutex of this.mutexes) {
            try {
                await mutex.lock(id, timeLeft);
                // unshift to unlock in reverse order
                lockedMutexes.unshift(mutex);

                if (useTimeout) {
                    // Never below one: a zero timeout means "wait forever" to some lock backends,
                    // and a negative one is refused outright — an exhausted budget must do neither.
                    timeLeft = Math.max(1, timeout! - hrTimeToMs(process.hrtime.bigint() - start));
                }
            } catch (error) {
                await this.unlockAll(id, lockedMutexes, 'swallow');

                // The failure to acquire is what the caller must see; a failing rollback cannot
                // mask it, and the rollback keeps going past a mutex that refuses, because leaving
                // an earlier lock held for ever is worse than an unreported cleanup failure.
                throw error;
            }
        }
    }

    async tryLock(id: LockID): Promise<boolean> {
        let locked: boolean = true;
        const lockedMutexes: DynamicMutex<LockID>[] = [];

        for (const mutex of this.mutexes) {
            try {
                if (await mutex.tryLock(id)) {
                    // unshift to unlock in reverse order
                    lockedMutexes.unshift(mutex);
                    continue;
                }
            } catch {
                // handle as failure
            }

            locked = false;
            break;
        }

        if (locked) {
            return true;
        }

        await this.unlockAll(id, lockedMutexes, 'swallow');

        return false;
    }

    async unlock(id: LockID): Promise<void> {
        // Mutexes are unlocked in reverse order
        await this.unlockAll(id, [...this.mutexes].reverse(), 'report');
    }

    /**
     * Unlock every given mutex, letting no failure stop the ones behind it. Composed mutexes are
     * different backends — an in-memory guard in front of a database lock, for instance — and a
     * transient failure of one backend must not leave the others held for ever.
     */
    private async unlockAll(
        id: LockID,
        mutexes: DynamicMutex<LockID>[],
        failures: 'report' | 'swallow',
    ): Promise<void> {
        const collected: unknown[] = [];

        for (const mutex of mutexes) {
            try {
                await mutex.unlock(id);
            } catch (e) {
                collected.push(e);
            }
        }

        if (failures === 'swallow' || collected.length === 0) {
            return;
        }

        if (collected.length === 1) {
            throw collected[0];
        }

        // Wrapped rather than thrown as a bare AggregateError, so a caller that distinguishes
        // release failures by type keeps working when more than one backend refused.
        throw UnableToReleaseLock.becauseOfError(
            id,
            new AggregateError(collected, `Unable to release every mutex for lock "${id}"`),
        );
    }
}

export default function hrTimeToMs(hrtime: bigint) {
    return Number(hrtime / 1000000n);
}
