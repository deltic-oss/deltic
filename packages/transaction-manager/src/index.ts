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

    // `async` reports a unit of work that throws before it returns a promise as a rejection,
    // the way the managers this one stands in for do.
    async runInTransaction<R>(fn: () => Promise<R>): Promise<R> {
        return fn();
    }

    async runInIsolation<R>(fn: () => Promise<R>): Promise<R> {
        return fn();
    }

    async runInIsolatedTransaction<R>(fn: () => Promise<R>): Promise<R> {
        return fn();
    }
}
