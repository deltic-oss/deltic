import {type DynamicMutex, type LockValue, UnableToAcquireLock, UnableToReleaseLock} from './index.js';

interface LockWaiter {
    done: boolean;
    promise: PromiseWithResolvers<void>;
}

export class MutexUsingMemory<LockID extends LockValue> implements DynamicMutex<LockID> {
    private readonly locks = new Map<LockID, true>();
    /**
     * Waiters per lock id. One shared queue used to serve every id, which meant releasing one lock
     * id woke a waiter for a *different* id while that id's holder was still running — mutual
     * exclusion broke as soon as two lock ids were contended at the same time.
     */
    private readonly waiters = new Map<LockID, LockWaiter[]>();

    lock(id: LockID, timeout?: number): Promise<void> {
        if (this.tryLockSync(id)) {
            return Promise.resolve();
        }

        const promise = Promise.withResolvers<void>();
        const lockWaiter: LockWaiter = {
            done: false,
            promise: promise,
        };
        const queue = this.waiters.get(id) ?? [];
        queue.push(lockWaiter);
        this.waiters.set(id, queue);
        let timer: ReturnType<typeof setTimeout> | undefined = undefined;

        if (timeout !== undefined) {
            timer = setTimeout(() => {
                lockWaiter.promise.reject('Time ran out.');
            }, timeout);
        }

        return promise.promise.then(
            () => {
                clearTimeout(timer);
                lockWaiter.done = true;
            },
            reason => {
                clearTimeout(timer);
                lockWaiter.done = true;
                throw UnableToAcquireLock.becauseOfError(id, reason);
            },
        );
    }

    private tryLockSync(id: LockID): boolean {
        if (this.locks.get(id)) {
            return false;
        }

        this.locks.set(id, true);

        return true;
    }

    async tryLock(id: LockID): Promise<boolean> {
        return this.tryLockSync(id);
    }

    async unlock(id: LockID): Promise<void> {
        if (!this.locks.get(id)) {
            throw UnableToReleaseLock.becauseOfError(id, 'Lock ID does not exist.');
        }

        const queue = this.waiters.get(id) ?? [];
        let waiter = queue.shift();

        // A waiter whose wait already ended — timed out, usually — must not receive the lock.
        while (waiter && waiter.done) {
            waiter = queue.shift();
        }

        if (queue.length === 0) {
            this.waiters.delete(id);
        }

        if (waiter) {
            // The lock stays held; it moves to the waiter.
            waiter.promise.resolve();
        } else {
            this.locks.delete(id);
        }
    }
}
