import type {TransactionManager} from './index.js';

/**
 * A transaction lifecycle operation an implementation performed, recorded in the
 * order the operations were *requested*. Completion may be serialised (a second
 * `begin()` waits for the active transaction), so this log describes intent, not
 * the order in which the operations took effect.
 */
export type TransactionLifecycleOperation = 'begin' | 'commit' | 'rollback';

/**
 * An implementation wired up for the contract, together with the observability
 * the contract needs. Implementations that delegate the actual work to a
 * collaborator (a connection pool, for instance) should record the operations on
 * that collaborator, because that is where begin/commit/rollback happen.
 */
export interface TransactionManagerUnderTest {
    manager: TransactionManager;
    lifecycle(): readonly TransactionLifecycleOperation[];
    rollbackCauses(): readonly unknown[];
    /**
     * Optional. Makes the next rollback fail, which allows the contract to verify
     * that the error from the unit of work is the one that surfaces.
     * Implementations that cannot fail a rollback leave this out.
     */
    failNextRollback?(): void;
}

export interface TransactionManagerContractCase {
    name: string;
    /**
     * Creates a fresh manager. Called once per contract test, so no state leaks
     * between cases.
     */
    create(): TransactionManagerUnderTest;
    /**
     * Whether the implementation keeps real transaction state: begin, commit and
     * rollback have an effect and `inTransaction()` reflects them, and `commit()`
     * and `rollback()` reject when no transaction is active. A no-op
     * implementation sets this to `false`, which makes the lifecycle expectations
     * inapplicable — they are skipped rather than weakened.
     */
    managesTransactions: boolean;
}

/**
 * The way consumers in this repository work with an ambient transaction: reuse the
 * caller's transaction when there is one, otherwise own the transaction for the
 * duration of the unit of work. Mirrors the aggregate repositories in
 * `@deltic/event-sourcing`.
 */
export async function runReusingAmbientTransaction<R>(
    manager: TransactionManager,
    unitOfWork: () => Promise<R>,
): Promise<R> {
    const alreadyInTransaction = manager.inTransaction();

    if (!alreadyInTransaction) {
        await manager.begin();
    }

    let result: R;

    try {
        result = await unitOfWork();
    } catch (error) {
        if (!alreadyInTransaction) {
            await manager.rollback(error);
        }

        throw error;
    }

    if (!alreadyInTransaction) {
        await manager.commit();
    }

    return result;
}

/**
 * Whether the promise is still unsettled after the microtask queue has been given
 * ample room to drain. Deterministic: no wall-clock waiting is involved.
 */
async function isStillPending(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    const settling = () => {
        settled = true;
    };
    // both outcomes are observed, so a rejection is never left unhandled
    void promise.then(settling, settling);

    for (let hop = 0; hop < 25; hop++) {
        await Promise.resolve();
    }

    return !settled;
}

function countOf(
    lifecycle: readonly TransactionLifecycleOperation[],
    operation: TransactionLifecycleOperation,
): number {
    return lifecycle.filter(recorded => recorded === operation).length;
}

/**
 * The behaviour every `TransactionManager` implementation has to provide. Feed it
 * any number of implementations; the expectations that only apply to managers
 * with real transaction state are skipped for the others.
 */
export function transactionManagerContract(cases: readonly TransactionManagerContractCase[]): void {
    describe.each(cases.map(contractCase => [contractCase.name, contractCase] as const))(
        'TransactionManager contract for %s',
        (_name, contractCase) => {
            const {create, managesTransactions, withoutActiveTransaction} = contractCase;
            const forManagedTransactions = test.runIf(managesTransactions);

            test('runInTransaction resolves with the result of the unit of work', async () => {
                const {manager} = create();

                const result = await manager.runInTransaction(async () => 'persisted');

                expect(result).toEqual('persisted');
            });

            test('runInTransaction runs the unit of work exactly once', async () => {
                const {manager} = create();
                let timesRun = 0;

                await manager.runInTransaction(async () => {
                    timesRun++;
                });

                expect(timesRun).toEqual(1);
            });

            test('runInTransaction rejects with the error the unit of work threw', async () => {
                const {manager} = create();
                const failure = new Error('the unit of work failed');

                await expect(manager.runInTransaction(async () => {
                    throw failure;
                })).rejects.toBe(failure);
            });

            test('the unit of work of runInTransaction observes an active transaction', async () => {
                const {manager} = create();
                let observed = false;

                await manager.runInTransaction(async () => {
                    observed = manager.inTransaction();
                });

                expect(observed).toEqual(true);
            });

            test('a successful runInTransaction leaves the transaction state as it found it', async () => {
                const {manager} = create();
                const before = manager.inTransaction();

                await manager.runInTransaction(async () => undefined);

                expect(manager.inTransaction()).toEqual(before);
            });

            test('a failed runInTransaction leaves the transaction state as it found it', async () => {
                const {manager} = create();
                const before = manager.inTransaction();

                await expect(manager.runInTransaction(async () => {
                    throw new Error('the unit of work failed');
                })).rejects.toThrow();

                expect(manager.inTransaction()).toEqual(before);
            });

            test('a nested runInTransaction resolves with the result of the inner unit of work', async () => {
                const {manager} = create();

                const result = await manager.runInTransaction(async () =>
                    manager.runInTransaction(async () => 'inner result'));

                expect(result).toEqual('inner result');
            });

            test('an error from a nested unit of work reaches the outer caller', async () => {
                const {manager} = create();
                const failure = new Error('the nested unit of work failed');

                await expect(manager.runInTransaction(async () =>
                    manager.runInTransaction(async () => {
                        throw failure;
                    }))).rejects.toBe(failure);
            });

            test('the error from the unit of work survives a failing rollback', async () => {
                const underTest = create();
                const failure = new Error('the unit of work failed');
                underTest.failNextRollback?.();

                await expect(underTest.manager.runInTransaction(async () => {
                    throw failure;
                })).rejects.toBe(failure);
            });

            test('runInIsolation resolves with the result of the unit of work', async () => {
                const {manager} = create();

                const result = await manager.runInIsolation(async () => 'isolated result');

                expect(result).toEqual('isolated result');
            });

            test('runInIsolation rejects with the error the unit of work threw', async () => {
                const {manager} = create();
                const failure = new Error('the isolated unit of work failed');

                await expect(manager.runInIsolation(async () => {
                    throw failure;
                })).rejects.toBe(failure);
            });

            test('runInIsolatedTransaction resolves with the result of the unit of work', async () => {
                const {manager} = create();

                const result = await manager.runInIsolatedTransaction(async () => 'isolated result');

                expect(result).toEqual('isolated result');
            });

            test('runInIsolatedTransaction rejects with the error the unit of work threw', async () => {
                const {manager} = create();
                const failure = new Error('the isolated unit of work failed');

                await expect(manager.runInIsolatedTransaction(async () => {
                    throw failure;
                })).rejects.toBe(failure);
            });

            test('the unit of work of runInIsolatedTransaction observes an active transaction', async () => {
                const {manager} = create();
                let observed = false;

                await manager.runInIsolatedTransaction(async () => {
                    observed = manager.inTransaction();
                });

                expect(observed).toEqual(true);
            });

            test('concurrent runInTransaction calls each resolve with their own result', async () => {
                const {manager} = create();
                const unitsOfWorkRun: string[] = [];

                const results = await Promise.all([
                    manager.runInTransaction(async () => {
                        unitsOfWorkRun.push('first');

                        return 'first result';
                    }),
                    manager.runInTransaction(async () => {
                        unitsOfWorkRun.push('second');

                        return 'second result';
                    }),
                ]);

                expect(results).toEqual(['first result', 'second result']);
                expect(unitsOfWorkRun).toHaveLength(2);
            });

            test('reusing an ambient transaction resolves with the result of the unit of work', async () => {
                const {manager} = create();

                const result = await runReusingAmbientTransaction(manager, async () => 'persisted');

                expect(result).toEqual('persisted');
            });

            test('reusing an ambient transaction propagates the failure of the unit of work', async () => {
                const {manager} = create();
                const failure = new Error('the unit of work failed');

                await expect(runReusingAmbientTransaction(manager, async () => {
                    throw failure;
                })).rejects.toBe(failure);
            });

            test(`commit() without an active transaction ${withoutActiveTransaction}`, async () => {
                const {manager} = create();

                if (withoutActiveTransaction === 'rejects') {
                    await expect(manager.commit()).rejects.toThrow();
                } else {
                    await expect(manager.commit()).resolves.toBeUndefined();
                }
            });

            test(`rollback() without an active transaction ${withoutActiveTransaction}`, async () => {
                const {manager} = create();

                if (withoutActiveTransaction === 'rejects') {
                    await expect(manager.rollback()).rejects.toThrow();
                } else {
                    await expect(manager.rollback()).resolves.toBeUndefined();
                }
            });

            test(`a second commit() ${withoutActiveTransaction}`, async () => {
                const {manager} = create();
                await manager.begin();
                await manager.commit();

                if (withoutActiveTransaction === 'rejects') {
                    await expect(manager.commit()).rejects.toThrow();
                } else {
                    await expect(manager.commit()).resolves.toBeUndefined();
                }
            });

            forManagedTransactions('inTransaction() reports no transaction before begin()', () => {
                const {manager} = create();

                expect(manager.inTransaction()).toEqual(false);
            });

            forManagedTransactions('inTransaction() follows begin() and commit()', async () => {
                const {manager} = create();

                expect(manager.inTransaction()).toEqual(false);

                await manager.begin();

                expect(manager.inTransaction()).toEqual(true);

                await manager.commit();

                expect(manager.inTransaction()).toEqual(false);
            });

            forManagedTransactions('inTransaction() follows begin() and rollback()', async () => {
                const {manager} = create();

                await manager.begin();

                expect(manager.inTransaction()).toEqual(true);

                await manager.rollback();

                expect(manager.inTransaction()).toEqual(false);
            });

            forManagedTransactions('runInTransaction commits once when the unit of work succeeds', async () => {
                const {manager, lifecycle} = create();

                await manager.runInTransaction(async () => undefined);

                expect(lifecycle()).toEqual(['begin', 'commit']);
            });

            forManagedTransactions('runInTransaction rolls back and does not commit when the unit of work throws', async () => {
                const {manager, lifecycle} = create();

                await expect(manager.runInTransaction(async () => {
                    throw new Error('the unit of work failed');
                })).rejects.toThrow();

                expect(lifecycle()).toEqual(['begin', 'rollback']);
            });

            forManagedTransactions('the rollback receives the error from the unit of work as its cause', async () => {
                const {manager, rollbackCauses} = create();
                const failure = new Error('the unit of work failed');

                await expect(manager.runInTransaction(async () => {
                    throw failure;
                })).rejects.toBe(failure);

                expect(rollbackCauses()).toEqual([failure]);
            });

            forManagedTransactions('a nested runInTransaction joins the active transaction instead of committing twice', async () => {
                const {manager, lifecycle} = create();

                await manager.runInTransaction(async () => {
                    await manager.runInTransaction(async () => undefined);
                });

                expect(lifecycle()).toEqual(['begin', 'commit']);
            });

            forManagedTransactions('a failing nested unit of work rolls the active transaction back once', async () => {
                const {manager, lifecycle, rollbackCauses} = create();
                const failure = new Error('the nested unit of work failed');

                await expect(manager.runInTransaction(async () =>
                    manager.runInTransaction(async () => {
                        throw failure;
                    }))).rejects.toBe(failure);

                expect(lifecycle()).toEqual(['begin', 'rollback']);
                expect(rollbackCauses()).toEqual([failure]);
            });

            forManagedTransactions('runInIsolation hides the ambient transaction from the unit of work', async () => {
                const {manager} = create();
                await manager.begin();
                let observed = true;

                await manager.runInIsolation(async () => {
                    observed = manager.inTransaction();
                });

                expect(observed).toEqual(false);
                expect(manager.inTransaction()).toEqual(true);

                await manager.commit();
            });

            forManagedTransactions('runInIsolatedTransaction transacts separately from the ambient transaction', async () => {
                const {manager, lifecycle} = create();
                await manager.begin();

                await manager.runInIsolatedTransaction(async () => undefined);

                expect(lifecycle()).toEqual(['begin', 'begin', 'commit']);
                expect(manager.inTransaction()).toEqual(true);

                await manager.commit();
            });

            forManagedTransactions('concurrent runInTransaction calls each get their own transaction', async () => {
                const {manager, lifecycle} = create();

                await Promise.all([
                    manager.runInTransaction(async () => undefined),
                    manager.runInTransaction(async () => undefined),
                ]);

                expect(countOf(lifecycle(), 'begin')).toEqual(2);
                expect(countOf(lifecycle(), 'commit')).toEqual(2);
                expect(countOf(lifecycle(), 'rollback')).toEqual(0);
                expect(manager.inTransaction()).toEqual(false);
            });

            forManagedTransactions('a second begin() waits for the active transaction to finish', async () => {
                const {manager} = create();
                await manager.begin();

                const secondBegin = manager.begin();

                expect(await isStillPending(secondBegin)).toEqual(true);

                await manager.commit();
                await secondBegin;

                expect(manager.inTransaction()).toEqual(true);

                await manager.commit();
            });

            forManagedTransactions('reusing an ambient transaction opens and commits one transaction when none is active', async () => {
                const {manager, lifecycle} = create();

                await runReusingAmbientTransaction(manager, async () => undefined);

                expect(lifecycle()).toEqual(['begin', 'commit']);
            });

            forManagedTransactions('reusing an ambient transaction leaves the transaction the caller opened alone', async () => {
                const {manager, lifecycle} = create();
                await manager.begin();

                await runReusingAmbientTransaction(manager, async () => undefined);

                expect(lifecycle()).toEqual(['begin']);
                expect(manager.inTransaction()).toEqual(true);

                await manager.commit();
            });

            forManagedTransactions('reusing an ambient transaction rolls back the transaction it opened itself', async () => {
                const {manager, lifecycle, rollbackCauses} = create();
                const failure = new Error('the unit of work failed');

                await expect(runReusingAmbientTransaction(manager, async () => {
                    throw failure;
                })).rejects.toBe(failure);

                expect(lifecycle()).toEqual(['begin', 'rollback']);
                expect(rollbackCauses()).toEqual([failure]);
            });
        },
    );
}
