export interface TransactionManager {
    begin(): Promise<void>;
    inTransaction(): boolean;
    runInIsolation<R>(fn: () => Promise<R>): Promise<R>;
    runInTransaction<R>(fn: () => Promise<R>): Promise<R>;
    runInIsolatedTransaction<R>(fn: () => Promise<R>): Promise<R>;
    commit(): Promise<void>;
    rollback(error?: unknown): Promise<void>;
}

export class NoopTransactionManager implements TransactionManager {
    async rollback(): Promise<void> {}

    inTransaction(): boolean {
        return true;
    }

    async begin(): Promise<void> {}

    async commit(): Promise<void> {}

    runInTransaction<R>(fn: () => Promise<R>): Promise<R> {
        return fn();
    }

    runInIsolation<R>(fn: () => Promise<R>): Promise<R> {
        return fn();
    }

    runInIsolatedTransaction<R>(fn: () => Promise<R>): Promise<R> {
        return fn();
    }
}
