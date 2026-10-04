import {NoopTransactionManager, type TransactionManager} from './index.js';
import {
    runReusingAmbientTransaction,
    type TransactionLifecycleOperation,
    transactionManagerContract,
    type TransactionManagerUnderTest,
} from './transaction-manager-contract.js';

/**
 * Hands out access in the order it was requested, the way the Postgres backed
 * implementation serialises transactions on a shared context.
 */
class SequentialAccess {
    private tail: Promise<void> = Promise.resolve();
    private releaseHolder: (() => void) | undefined = undefined;

    async lock(): Promise<void> {
        const predecessor = this.tail;
        let release: () => void = () => {};
        this.tail = new Promise<void>(resolve => {
            release = resolve;
        });

        await predecessor;

        this.releaseHolder = release;
    }

    unlock(): void {
        const release = this.releaseHolder;
        this.releaseHolder = undefined;
        release?.();
    }
}

type IsolationScope = {
    access: SequentialAccess;
    transaction: symbol | undefined;
};

function createIsolationScope(): IsolationScope {
    return {access: new SequentialAccess(), transaction: undefined};
}

/**
 * An in-memory transaction manager with the same bookkeeping as the Postgres
 * backed implementation in `@deltic/async-pg-pool`: one transaction per scope,
 * a second `begin()` waits for the active transaction, `runInIsolation` gives the
 * unit of work a scope of its own, and finalising without an active transaction is
 * an error. Scopes are kept on a stack, which covers nested isolation but not
 * isolation from concurrent tasks — the real implementation uses async context for
 * that.
 */
class TransactionManagerUsingMemory implements TransactionManager {
    private readonly scopes: IsolationScope[] = [createIsolationScope()];
    private nextRollbackFails = false;

    failNextRollback(): void {
        this.nextRollbackFails = true;
    }

    private currentScope(): IsolationScope {
        return this.scopes.at(-1)!;
    }

    inTransaction(): boolean {
        return this.currentScope().transaction !== undefined;
    }

    async begin(): Promise<void> {
        const scope = this.currentScope();
        await scope.access.lock();
        scope.transaction = Symbol('transaction');
    }

    async commit(): Promise<void> {
        const scope = this.currentScope();

        if (scope.transaction === undefined) {
            throw new Error('Unable to commit: no transaction is active.');
        }

        scope.transaction = undefined;
        scope.access.unlock();
    }

    async rollback(_error?: unknown): Promise<void> {
        const scope = this.currentScope();

        if (scope.transaction === undefined) {
            throw new Error('Unable to roll back: no transaction is active.');
        }

        scope.transaction = undefined;
        scope.access.unlock();

        if (this.nextRollbackFails) {
            this.nextRollbackFails = false;

            throw new Error('Unable to roll back: the connection was lost.');
        }
    }

    async runInTransaction<R>(fn: () => Promise<R>): Promise<R> {
        if (this.inTransaction()) {
            return fn();
        }

        await this.begin();
        let result: R;

        try {
            result = await fn();
        } catch (error) {
            try {
                await this.rollback(error);
            } catch {
                // the failure of the unit of work is the one the caller needs to see
            }

            throw error;
        }

        await this.commit();

        return result;
    }

    async runInIsolation<R>(fn: () => Promise<R>): Promise<R> {
        this.scopes.push(createIsolationScope());
        let result: R;

        try {
            result = await fn();
        } catch (error) {
            this.scopes.pop();

            throw error;
        }

        const scope = this.scopes.pop()!;

        if (scope.transaction !== undefined) {
            throw new Error('Isolation ended while a transaction was still active.');
        }

        return result;
    }

    runInIsolatedTransaction<R>(fn: () => Promise<R>): Promise<R> {
        return this.runInIsolation(() => this.runInTransaction(fn));
    }
}

/**
 * Observes the lifecycle operations a manager performs without changing what it
 * does, so the contract can assert on them.
 */
function recordLifecycleOf(manager: TransactionManager): TransactionManagerUnderTest {
    const beginSpy = vi.spyOn(manager, 'begin');
    const commitSpy = vi.spyOn(manager, 'commit');
    const rollbackSpy = vi.spyOn(manager, 'rollback');
    const recordedAs = (operation: TransactionLifecycleOperation, invocations: readonly number[]) =>
        invocations.map(order => ({order, operation}));

    return {
        manager,
        lifecycle: () =>
            [
                ...recordedAs('begin', beginSpy.mock.invocationCallOrder),
                ...recordedAs('commit', commitSpy.mock.invocationCallOrder),
                ...recordedAs('rollback', rollbackSpy.mock.invocationCallOrder),
            ]
                .sort((first, second) => first.order - second.order)
                .map(({operation}) => operation),
        rollbackCauses: () => rollbackSpy.mock.calls.map(([cause]) => cause),
    };
}

transactionManagerContract([
    {
        name: 'NoopTransactionManager',
        create: () => recordLifecycleOf(new NoopTransactionManager()),
        managesTransactions: false,
        withoutActiveTransaction: 'ignores',
    },
    {
        name: 'TransactionManagerUsingMemory',
        create: () => {
            const manager = new TransactionManagerUsingMemory();

            return {
                ...recordLifecycleOf(manager),
                failNextRollback: () => manager.failNextRollback(),
            };
        },
        managesTransactions: true,
        withoutActiveTransaction: 'rejects',
    },
]);

describe('NoopTransactionManager', () => {
    test('reports an active transaction from the start, so callers never open one', () => {
        /**
         * The aggregate repositories in @deltic/event-sourcing branch on inTransaction() to
         * decide whether they own the transaction. Claiming to be inside one keeps them from
         * managing a transaction that does not exist.
         */
        const manager = new NoopTransactionManager();

        expect(manager.inTransaction()).toEqual(true);
    });

    test('keeps reporting an active transaction across the whole lifecycle', async () => {
        // consumers hold the interface, which is also the only way to hand rollback a cause
        const manager: TransactionManager = new NoopTransactionManager();

        await manager.begin();

        expect(manager.inTransaction()).toEqual(true);

        await manager.begin();

        expect(manager.inTransaction()).toEqual(true);

        await manager.commit();

        expect(manager.inTransaction()).toEqual(true);

        await manager.rollback(new Error('the unit of work failed'));

        expect(manager.inTransaction()).toEqual(true);
    });

    test('accepts finalising a transaction that was never started', async () => {
        const manager = new NoopTransactionManager();

        await expect(manager.commit()).resolves.toBeUndefined();
        await expect(manager.rollback()).resolves.toBeUndefined();
    });

    test('does not rethrow the cause handed to rollback', async () => {
        const manager: TransactionManager = new NoopTransactionManager();

        await expect(manager.rollback(new Error('the unit of work failed'))).resolves.toBeUndefined();
    });

    test('runs units of work without performing any transaction operation', async () => {
        const {manager, lifecycle} = recordLifecycleOf(new NoopTransactionManager());

        await manager.runInTransaction(async () => undefined);
        await manager.runInIsolation(async () => undefined);
        await manager.runInIsolatedTransaction(async () => undefined);

        expect(lifecycle()).toEqual([]);
    });

    test('lets a consumer that reuses an ambient transaction skip transaction management', async () => {
        // arrange
        const {manager, lifecycle} = recordLifecycleOf(new NoopTransactionManager());
        const persisted: string[] = [];

        // act
        await runReusingAmbientTransaction(manager, async () => {
            persisted.push('aggregate');
        });

        // assert
        expect(persisted).toEqual(['aggregate']);
        expect(lifecycle()).toEqual([]);
    });

    test('propagates the failure of a consumer that reuses an ambient transaction', async () => {
        const {manager, lifecycle} = recordLifecycleOf(new NoopTransactionManager());
        const failure = new Error('the unit of work failed');

        await expect(runReusingAmbientTransaction(manager, async () => {
            throw failure;
        })).rejects.toBe(failure);

        expect(lifecycle()).toEqual([]);
    });

    // see .claude-work/issues/transaction-manager-noop-throws-instead-of-rejecting.md
    it.fails('reports a unit of work that fails before it returns a promise as a rejection', async () => {
        const manager = new NoopTransactionManager();
        const failure = new Error('the unit of work failed before it returned a promise');
        const unitOfWork = (): Promise<void> => {
            throw failure;
        };

        await expect(manager.runInTransaction(unitOfWork)).rejects.toBe(failure);
        await expect(manager.runInIsolation(unitOfWork)).rejects.toBe(failure);
        await expect(manager.runInIsolatedTransaction(unitOfWork)).rejects.toBe(failure);
    });
});
