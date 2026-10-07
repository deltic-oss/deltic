import type {InputForServiceOfType, NextFunction, ServiceStructure} from './index.js';
import type {DynamicMutex, LockValue} from '@deltic/mutex';
import {defaultLockTimeoutMs, type LockIDResolver, type LockSkipDetector} from './shared-for-locking.js';

export * from './shared-for-locking.js';

export function createServiceLockingMiddleware<S extends ServiceStructure<S>, LockId extends LockValue>({
    mutex,
    lockResolver,
    shouldSkip = () => false,
    timeoutMs = defaultLockTimeoutMs,
}: {
    mutex: DynamicMutex<LockId>;
    shouldSkip?: LockSkipDetector<S>;
    lockResolver: LockIDResolver<S, LockId>;
    timeoutMs?: number;
}) {
    return async <T extends keyof S>(
        input: InputForServiceOfType<S, T>,
        next: NextFunction<S>,
    ): Promise<S[T]['response']> => {

        if (shouldSkip(input)) {
            return next(input);
        }

        const lockID = lockResolver(input);
        await mutex.lock(lockID, timeoutMs);

        try {
            return await next(input);
        } finally {
            await mutex.unlock(lockID);
        }
    };
}
