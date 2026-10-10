import {setTimeout as wait} from 'node:timers/promises';
import {Pool, type PoolConfig} from 'pg';
import {
    AsyncPgPool,
    type AsyncPgPoolContextSlot,
    asyncPgPoolContextSlot,
    type AsyncPgPoolOptions,
    type Connection,
    TransactionManagerUsingPg,
    UnableToCommitTransaction,
} from './index.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {type Context, composeContextSlotsForTesting, composeContextSlots} from '@deltic/context';
import {pgTestCredentials} from '../../pg-credentials.js';

/**
 * Owned by this test file, so it is safe to create and drop while other suites
 * use the same database.
 */
const ledgerTable = 'async_pool_ledger';
const insertLedgerEntry = `INSERT INTO ${ledgerTable} (identifier, note) VALUES ($1, $2)`;
const selectLedgerEntry = `SELECT note FROM ${ledgerTable} WHERE identifier = $1`;

/**
 * Holds a constraint that is only checked when the transaction commits, so a test
 * can fail a commit the way a real deferred constraint does.
 */
const deferredLedgerTable = 'async_pool_deferred_ledger';
const insertDeferredLedgerEntry = `INSERT INTO ${deferredLedgerTable} (identifier) VALUES ($1)`;

/**
 * Tests that expect a connection to break register these, so a connection level
 * error does not surface as an unhandled error event.
 */
const ignoreConnectionErrors = (pgPool: Pool, connection: Connection): void => {
    const ignore = () => undefined;
    pgPool.on('error', ignore);
    connection.on('error', ignore);
};

/**
 * A case that talks to Postgres and is expected to pass, so it keeps the configured retries.
 */
const databaseTest = {timeout: 20000} as const;

/**
 * The escape hatch the pool itself uses to hand a client back to `pg`. Tests that
 * prove a connection leak use it to clean up, so a proven leak does not keep a
 * backend occupied for the rest of the run.
 */
const poolRelease: unique symbol = Symbol.for('@deltic/async-pg-pool/release');

type ConnectionWithPoolRelease = {
    [poolRelease]?: (error?: Error) => void;
    release?: (error?: Error) => void;
};

function abandonConnection(connection: Connection | unknown): void {
    const client = connection as ConnectionWithPoolRelease;
    const abandoned = new Error('abandoned by the test');

    try {
        // the pool replaces `release` with a thrower once it owns a client, so the
        // symbol it keeps around is the only way back to `pg`
        if (client[poolRelease] === undefined) {
            client.release?.(abandoned);
        } else {
            client[poolRelease](abandoned);
        }
    } catch {
        // a client that is already gone needs no cleanup
    }
}

const stillPending = Symbol('still pending');

/**
 * Bounds a promise that is expected to settle, so a defect shows up as a failed
 * expectation instead of a test that hangs until the runner gives up.
 */
async function outcomeWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T | typeof stillPending> {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    // keeps a late rejection of an abandoned promise from surfacing as unhandled
    void promise.catch(() => undefined);
    const deadline = new Promise<typeof stillPending>(resolve => {
        timer = setTimeout(() => resolve(stillPending), milliseconds);
    });

    try {
        return await Promise.race([promise, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Lets a fixed number of flows meet at the same point, so interleaving is
 * expressed by the test instead of by timing.
 */
function meetingPoint(participants: number): () => Promise<void> {
    const reached = Promise.withResolvers<void>();
    let expected = participants;

    return async () => {
        if (--expected === 0) {
            reached.resolve();
        }

        return reached.promise;
    };
}

describe('AsyncPgPool', () => {
    let pool: Pool;
    let provider: AsyncPgPool;
    const factoryWithStaticPool = (options: AsyncPgPoolOptions = {}) => new AsyncPgPool(pool, options);
    const factoryWithAsyncPool = (options: AsyncPgPoolOptions = {}) => {
        const context = composeContextSlotsForTesting([asyncPgPoolContextSlot]);

        return new AsyncPgPool(pool, options, context);
    };
    const asyncScopedContext = (): Context<AsyncPgPoolContextSlot> =>
        composeContextSlots([asyncPgPoolContextSlot], new AsyncLocalStorage());
    /**
     * A pool of its own, so a test can reason about connection capacity without
     * observing the shared database server. Exhaustion surfaces as a rejection
     * instead of a hang.
     */
    const dedicatedPool = (config: PoolConfig = {}): Pool => new Pool({
        ...pgTestCredentials,
        max: 1,
        connectionTimeoutMillis: 500,
        ...config,
    });
    /**
     * Reports whether the pool can still serve a connection, so an exhausted pool
     * shows up as an expectation about capacity instead of a driver rejection.
     */
    const capacityOf = async (pgPool: Pool): Promise<'available' | 'exhausted'> => {
        const outcome = await outcomeWithin(pgPool.connect().then(
            client => {
                abandonConnection(client);

                return 'available' as const;
            },
            () => 'exhausted' as const,
        ), 3000);

        return outcome === stillPending ? 'exhausted' : outcome;
    };
    /**
     * Has the server end the session of a connection, and waits until the connection noticed.
     * Only `end` is listened to here: an `error` without a listener takes the process down,
     * which is what the pool has to prevent.
     */
    const endSessionOf = async (connection: Connection): Promise<void> => {
        const ended = new Promise<void>(resolve => connection.once('end', () => resolve()));
        const {rows: [backend]} = await connection.query<{pid: number}>('SELECT pg_backend_pid() AS pid');
        await pool.query('SELECT pg_terminate_backend($1)', [backend!.pid]);

        expect(await outcomeWithin(ended, 2000)).not.toBe(stillPending);
    };
    /**
     * Runs a unit of work in a context scope of its own and flushes afterwards, the
     * way a request or message handler would.
     */
    const inScope = async (
        options: AsyncPgPoolOptions,
        unitOfWork: (scoped: AsyncPgPool, context: Context<AsyncPgPoolContextSlot>) => Promise<void>,
        pgPool: Pool = pool,
    ): Promise<void> => {
        const context = asyncScopedContext();
        const pool = new AsyncPgPool(pgPool, options, context);

        return context.run(async () => {
            try {
                await unitOfWork(pool, context);
            } finally {
                await pool.flush();
            }
        });
    };

    beforeAll(async () => {
        pool = new Pool(pgTestCredentials);
        await pool.query(`DROP TABLE IF EXISTS ${ledgerTable}`);
        await pool.query(`
            CREATE TABLE ${ledgerTable}
            (
                identifier TEXT PRIMARY KEY,
                note       TEXT NOT NULL
            );
        `);
        await pool.query(`DROP TABLE IF EXISTS ${deferredLedgerTable}`);
        await pool.query(`
            CREATE TABLE ${deferredLedgerTable}
            (
                identifier TEXT NOT NULL,
                CONSTRAINT ${deferredLedgerTable}_unique UNIQUE (identifier) DEFERRABLE INITIALLY DEFERRED
            );
        `);
    });

    afterAll(async () => {
        await pool.query(`DROP TABLE IF EXISTS ${ledgerTable}`);
        await pool.query(`DROP TABLE IF EXISTS ${deferredLedgerTable}`);
        await pool.end();
    });

    afterEach(async () => {
        if (provider && !provider.wasFlushed()) {
            await provider.flush();
        }
    });

    describe.each([
        ['pool, static transaction context', factoryWithStaticPool, undefined, undefined],
        ['pool, async transaction context', factoryWithAsyncPool, undefined, undefined],
        ['pool, without sharing primary connections', factoryWithAsyncPool, false, undefined],
        ['pool, without locking after flushing', factoryWithAsyncPool, undefined, false],
    ] as const)('basics for %s', (_name, factory, keepPrimaryConnection, lockAfterFlush) => {
        beforeEach(() => {
            provider = factory({
                freshResetQuery: 'RESET ALL',
                keepPrimaryConnection,
                lockAfterFlush,
            });
        });

        test('smoketest, claiming a client', async () => {
            const client = await provider.claim();

            try {
                const result = await client.query('SELECT 1 as num');
                expect(result.rowCount).toEqual(1);
                expect(result.rows[0].num).toEqual(1);
            } finally {
                await provider.release(client);
            }
        });

        test('smoketest, using a plain transaction', async () => {
            expect(provider.inTransaction()).toEqual(false);

            const client = await provider.begin();

            expect(provider.inTransaction()).toEqual(true);

            try {
                const result = await client.query('SELECT 1 as num');
                expect(result.rowCount).toEqual(1);
                expect(result.rows[0].num).toEqual(1);
            } finally {
                await provider.commit(client);
            }

            expect(provider.inTransaction()).toEqual(false);
        });

        test('smoketest, concurrent does not deadlock', async () => {
            const collected: string[] = [];

            async function runInTransaction(value: string): Promise<void> {
                const transaction = await provider.begin();
                const result = await transaction.query<{v: string}>(`SELECT '${value}' as v`);
                result.rows.forEach(row => collected.push(row.v));
                await provider.commit(transaction);
            }

            await Promise.allSettled([
                runInTransaction('one'),
                runInTransaction('two'),
            ]);

            expect(collected).toContainEqual('one');
            expect(collected).toContainEqual('two');
        });

        test('leaves the connection of the active transaction to whoever finalises it', async () => {
            let released = 0;
            provider = factory({
                freshResetQuery: 'RESET ALL',
                keepPrimaryConnection,
                lockAfterFlush,
                onRelease: () => {
                    released++;
                },
            });
            const transaction = await provider.begin();
            const connection = await provider.primary();

            await provider.release(connection);
            await provider.release(connection, new Error('a query of the unit of work failed'));
            await connection.query('SELECT 1');
            expect(released).toEqual(0);

            await provider.commit(transaction);

            expect(released).toEqual(1);
        });

        test('smoketest, using an encapsulated transaction', async () => {
            let wasInTransaction: boolean = false;

            expect(provider.inTransaction()).toEqual(false);

            await provider.runInTransaction(async () => {
                wasInTransaction = provider.inTransaction();
            });

            expect(wasInTransaction).toEqual(true);
        });

        test('primary connection is the same or not', async () => {
            const expectConnectionsToBeTheSame = keepPrimaryConnection === undefined;
            const connection = await provider.primary();
            const anotherConnection = await provider.primary();

            expect(connection === anotherConnection).toEqual(expectConnectionsToBeTheSame);

            await provider.release(connection);
            await provider.release(anotherConnection);
        });

        test.runIf(lockAfterFlush === undefined)('errors when trying to obtain a connection after flushing', async () => {
            await provider.flush();

            await expect(provider.claim()).rejects.toThrow();
        });

        test.runIf(lockAfterFlush === false)('does not error when trying to obtain a connection after flushing', async () => {
            await provider.flush();
            let connection: Connection | undefined = undefined;

            const obtainConnection = async () => {
                connection = await provider.claim();
            };

            try {
                await expect(obtainConnection()).resolves.not.toThrow();
            } finally {
                if (connection) {
                    await provider.release(connection);
                }
            }

        });

        test('work of a successful unit of work is committed', async () => {
            const identifier = randomUUID();

            await provider.runInTransaction(async () => {
                const connection = await provider.primary();
                await connection.query(insertLedgerEntry, [identifier, 'committed']);
            });

            const result = await pool.query(selectLedgerEntry, [identifier]);

            expect(result.rows).toEqual([{note: 'committed'}]);
        });

        test('work of a failing unit of work is rolled back', async () => {
            const identifier = randomUUID();

            await expect(provider.runInTransaction(async () => {
                const connection = await provider.primary();
                await connection.query(insertLedgerEntry, [identifier, 'rolled back']);

                throw new Error('the unit of work failed');
            })).rejects.toThrow('the unit of work failed');

            const result = await pool.query(selectLedgerEntry, [identifier]);

            expect(result.rowCount).toEqual(0);
        });

        test('work of a nested unit of work is rolled back with the transaction it joined', async () => {
            const identifier = randomUUID();

            await expect(provider.runInTransaction(async () => {
                await provider.runInTransaction(async () => {
                    const connection = await provider.primary();
                    await connection.query(insertLedgerEntry, [identifier, 'nested']);
                });

                throw new Error('the outer unit of work failed');
            })).rejects.toThrow('the outer unit of work failed');

            const result = await pool.query(selectLedgerEntry, [identifier]);

            expect(result.rowCount).toEqual(0);
        });

        test('asking for a transaction connection without a transaction is refused', () => {
            expect(() => provider.withTransaction()).toThrow('no transaction was active');
        });

        test('flushing twice is harmless', async () => {
            await provider.flush();

            await expect(provider.flush()).resolves.toBeUndefined();
        });
    });

    describe('primary connections and flushing async context', () => {
        beforeEach(() => {
            provider = factoryWithStaticPool({
                freshResetQuery: 'RESET ALL',
            });
        });

        test('primary connections are re-used', async () => {
            let connection = await provider.primary();

            await connection.query('SET app.custom_value = "something"');

            await provider.release(connection);

            connection = await provider.primary();
            const result = await connection.query("SELECT current_setting('app.custom_value') as value");

            expect(result.rows[0].value).toEqual('something');
        });

        test('claimed connections are re-used', async () => {
            let connection = await provider.claim();

            await connection.query('SET app.custom_value = "something"');

            await provider.release(connection);

            connection = await provider.claim();
            const result = await connection.query("SELECT current_setting('app.custom_value') as value");
            await provider.release(connection);

            expect(result.rows[0].value).toEqual('something');
        });

        test('fresh connections have reset state', async () => {
            let connection = await provider.claim();

            await connection.query('SET app.custom_value = "something"');

            await provider.release(connection);

            connection = await provider.claimFresh();
            const result = await connection.query("SELECT current_setting('app.custom_value') as value");
            await provider.release(connection);

            expect(result.rows[0].value).toEqual('');
        });

        test('transactions use the primary connection', async () => {
            const connection = await provider.primary();

            await connection.query('SET app.custom_value = "something"');

            await provider.release(connection);

            const transaction = await provider.begin();
            const result = await transaction.query("SELECT current_setting('app.custom_value') as value");
            await provider.rollback(transaction);

            expect(result.rows[0].value).toEqual('something');
        });
    });

    describe.each([['pool', factoryWithStaticPool]] as const)('transactional behaviour using %s', (name, factory) => {
        const tableName = `transactions_test_for_${name.toLowerCase().replace(/ /g, '_')}`;

        beforeAll(async () => {
            provider = factory();
            await pool.query(`
                CREATE TABLE ${tableName}
                (
                    identifier TEXT UNIQUE NOT NULL,
                    name       TEXT        NOT NULL,
                    age        INTEGER
                );
            `);
        });

        test('beginning and committing a transaction', async () => {
            const connection = await provider.begin();

            await provider.commit(connection);
        });

        afterAll(async () => {
            await pool.query(`DROP TABLE ${tableName}`);
        });
    });

    test('being able to set a setting for a connection', async () => {
        let index = 0;
        let usedConnection: Connection | undefined = undefined;
        const provider = new AsyncPgPool(pool, {
            keepConnections: 0,
            onRelease: 'RESET app.tenant_id',
            onClaim: client => client.query(`SET app.tenant_id = '${++index}'`),
        });

        async function fetchTenantId() {
            await using connection = await provider.claim();
            const result = await connection.query("SELECT current_setting('app.tenant_id') as num");
            usedConnection = connection;

            return Number(result.rows[0].num);
        }

        expect(await fetchTenantId()).toEqual(1);
        expect(await fetchTenantId()).toEqual(2);

        // Verify the tenant ID does not leak when the connection is
        const connection = await pool.connect();
        // Strict equal check to ensure the connection was the same as used before.
        expect(usedConnection).toStrictEqual(connection);
        const result = await connection.query("SELECT current_setting('app.tenant_id') as num");
        connection.release();

        expect(result.rows[0].num).toEqual('');
    });

    test('using async dispose to close a connection', async () => {
        let released = false;
        const provider = new AsyncPgPool(pool, {
            onRelease: () => {
                released = true;
            },
        });

        await (async () => {
            await using connection = await provider.claim();

            const result = await connection.query('SELECT 1 as num');
            expect(result.rowCount).toEqual(1);
            expect(result.rows[0].num).toEqual(1);
        })();

        expect(released).toEqual(true);
    });

    test('runInIsolation() creates an isolated transaction context scope', async () => {
        const context = composeContextSlots([asyncPgPoolContextSlot], new AsyncLocalStorage());

        const provider = new AsyncPgPool(pool, {}, context);

        let innerInTransaction = false;

        await provider.runInIsolation(async () => {
            await provider.runInTransaction(async () => {
                innerInTransaction = provider.inTransaction();
            });
        });

        expect(innerInTransaction).toEqual(true);
    });

    test('runInIsolatedTransaction() creates an isolated transaction context scope', async () => {
        const context = composeContextSlots([asyncPgPoolContextSlot], new AsyncLocalStorage());

        const provider = new AsyncPgPool(pool, {}, context);

        let innerInTransaction = false;

        await provider.runInIsolatedTransaction(async () => {
            innerInTransaction = provider.inTransaction();
        });

        expect(innerInTransaction).toEqual(true);
    });

    describe('scoping connections to a logical flow', () => {
        test('concurrent flows each work in a transaction of their own', async () => {
            const context = asyncScopedContext();
            const scoped = new AsyncPgPool(pool, {}, context);
            const failing = randomUUID();
            const succeeding = randomUUID();
            const bothWrote = meetingPoint(2);
            const connections = new Map<string, Connection>();
            const visibleTo = new Map<string, string[]>();

            const flow = (identifier: string, fail: boolean) => context.run(async () => {
                try {
                    await scoped.runInTransaction(async () => {
                        const connection = await scoped.primary();
                        connections.set(identifier, connection);
                        await connection.query(insertLedgerEntry, [identifier, 'concurrent']);
                        await bothWrote();
                        const result = await connection.query<{identifier: string}>(
                            `SELECT identifier FROM ${ledgerTable} WHERE identifier = ANY ($1::text[]) ORDER BY identifier`,
                            [[failing, succeeding]],
                        );
                        visibleTo.set(identifier, result.rows.map(row => row.identifier));

                        if (fail) {
                            throw new Error('the failing flow failed');
                        }
                    });
                } finally {
                    await scoped.flush();
                }
            });

            const [failed, succeeded] = await Promise.allSettled([
                flow(failing, true),
                flow(succeeding, false),
            ]);

            expect(failed.status).toEqual('rejected');
            expect(succeeded.status).toEqual('fulfilled');
            expect(connections.get(failing)).not.toBe(connections.get(succeeding));
            expect(visibleTo.get(failing)).toEqual([failing]);
            expect(visibleTo.get(succeeding)).toEqual([succeeding]);

            const surviving = await pool.query<{identifier: string}>(
                `SELECT identifier FROM ${ledgerTable} WHERE identifier = ANY ($1::text[])`,
                [[failing, succeeding]],
            );

            expect(surviving.rows.map(row => row.identifier)).toEqual([succeeding]);
        }, 15000);

        test('every part of a flow writes through the same transaction', async () => {
            const firstWrite = randomUUID();
            const secondWrite = randomUUID();

            await inScope({}, async scoped => {
                await expect(scoped.runInTransaction(async () => {
                    const usedByOneModule = await scoped.primary();
                    await usedByOneModule.query(insertLedgerEntry, [firstWrite, 'one module']);

                    const usedByAnotherModule = await scoped.primary();
                    await usedByAnotherModule.query(insertLedgerEntry, [secondWrite, 'another module']);

                    expect(usedByAnotherModule).toBe(usedByOneModule);
                    expect(usedByAnotherModule).toBe(scoped.withTransaction());

                    throw new Error('the unit of work failed');
                })).rejects.toThrow('the unit of work failed');
            });

            const surviving = await pool.query(
                `SELECT identifier FROM ${ledgerTable} WHERE identifier = ANY ($1::text[])`,
                [[firstWrite, secondWrite]],
            );

            expect(surviving.rowCount).toEqual(0);
        }, 15000);

        test('an isolated unit of work cannot see the transaction of its caller', async () => {
            const identifier = randomUUID();

            await inScope({}, async scoped => {
                await scoped.runInTransaction(async () => {
                    const transaction = await scoped.primary();
                    await transaction.query(insertLedgerEntry, [identifier, 'outer']);

                    await scoped.runInIsolation(async () => {
                        expect(scoped.inTransaction()).toEqual(false);
                        const isolated = await scoped.primary();

                        expect(isolated).not.toBe(transaction);

                        const result = await isolated.query(selectLedgerEntry, [identifier]);

                        expect(result.rowCount).toEqual(0);
                    });

                    expect(scoped.inTransaction()).toEqual(true);

                    throw new Error('the unit of work failed');
                }).catch(() => undefined);
            });
        }, 15000);

        test('working without a context scope is refused instead of silently opening a connection', async () => {
            const context = asyncScopedContext();
            const unscoped = new AsyncPgPool(pool, {}, context);

            await expect(unscoped.primary()).rejects.toThrow('No transaction context available');
            await expect(unscoped.claim()).rejects.toThrow('No transaction context available');
            await expect(unscoped.begin()).rejects.toThrow('No transaction context available');
            expect(() => unscoped.inTransaction()).toThrow('No transaction context available');
            expect(unscoped.wasFlushed()).toEqual(false);
        });

    });

    describe('returning connections to the pool', () => {
        test('a failing unit of work does not strand its connection', async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});

            try {
                await inScope({}, async scoped => {
                    for (let attempt = 0; attempt < 4; attempt++) {
                        await expect(scoped.runInTransaction(async () => {
                            const connection = await scoped.primary();
                            await connection.query('SELECT 1');

                            throw new Error('the unit of work failed');
                        })).rejects.toThrow('the unit of work failed');
                    }

                    // the pool holds two connections: without release this would time out
                    const connection = await scoped.claim();
                    const result = await connection.query<{n: number}>('SELECT 1 as n');
                    await scoped.release(connection);

                    expect(result.rows[0].n).toEqual(1);
                }, dedicated);
            } finally {
                await dedicated.end();
            }
        }, 20000);

        test('a connection whose transaction rolled back cleanly returns to the pool', async () => {
            const dedicated = dedicatedPool({connectionTimeoutMillis: 2000});
            const identifier = randomUUID();

            try {
                await inScope({}, async scoped => {
                    await expect(scoped.runInTransaction(async () => {
                        const connection = await scoped.primary();
                        await connection.query(insertLedgerEntry, [identifier, 'never committed']);

                        throw new Error('the unit of work failed');
                    })).rejects.toThrow('the unit of work failed');

                    // The ROLLBACK succeeded, so the session is clean and stays pooled.
                    expect(dedicated.totalCount).toEqual(1);
                    expect(dedicated.idleCount).toEqual(1);

                    const connection = await scoped.claim();
                    const result = await connection.query<{count: string}>(
                        `SELECT count(*) as count FROM ${ledgerTable} WHERE identifier = $1`,
                        [identifier],
                    );
                    await scoped.release(connection);

                    expect(result.rows[0].count).toEqual('0');
                }, dedicated);
            } finally {
                await dedicated.end();
            }
        }, 20000);

        test('a connection whose ROLLBACK fails is destroyed', async () => {
            const dedicated = dedicatedPool({connectionTimeoutMillis: 2000});
            dedicated.on('acquire', client => {
                const query = client.query.bind(client) as (...args: unknown[]) => unknown;
                Object.assign(client, {
                    query: (...args: unknown[]) => args[0] === 'ROLLBACK'
                        ? Promise.reject(new Error('the rollback failed'))
                        : query(...args),
                });
            });

            try {
                await inScope({}, async scoped => {
                    await expect(scoped.runInTransaction(async () => {
                        await (await scoped.primary()).query('SELECT 1');

                        throw new Error('the unit of work failed');
                    })).rejects.toThrow();

                    expect(dedicated.totalCount).toEqual(0);
                }, dedicated);
            } finally {
                await dedicated.end();
            }
        }, 20000);

        test('a connection is not handed back to the pool twice', async () => {
            await inScope({}, async scoped => {
                const connection = await scoped.claim();
                await scoped.release(connection);

                await expect(scoped.release(connection)).rejects.toThrow('already been released');
            });
        }, 15000);

        test('a disposed connection is not handed back to the pool twice', async () => {
            await inScope({}, async scoped => {
                let disposed: Connection | undefined = undefined;

                await (async () => {
                    await using connection = await scoped.claim();
                    disposed = connection;
                    await connection.query('SELECT 1');
                })();

                await expect(scoped.release(disposed!)).rejects.toThrow('already been released');
            });
        }, 15000);

        test('returns an idle connection to the pool when it is evicted', databaseTest, async () => {
            const dedicated = dedicatedPool();
            let evicted: Connection | undefined = undefined;

            try {
                await inScope({keepConnections: 1, maxIdleMs: 20}, async scoped => {
                    const connection = await scoped.claim();
                    evicted = connection;
                    await scoped.release(connection);
                    await wait(60);

                    expect(await capacityOf(dedicated)).toEqual('available');
                }, dedicated);
            } finally {
                if (evicted !== undefined) {
                    abandonConnection(evicted);
                }

                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('returns the connection to the pool when the claim hook fails', databaseTest, async () => {
            const dedicated = dedicatedPool();
            const checkedOut: unknown[] = [];
            dedicated.on('acquire', client => {
                checkedOut.push(client);
            });

            try {
                await inScope({
                    onClaim: () => {
                        throw new Error('setting up the connection failed');
                    },
                }, async scoped => {
                    await expect(scoped.claim()).rejects.toThrow();

                    expect(await capacityOf(dedicated)).toEqual('available');
                }, dedicated);
            } finally {
                for (const client of checkedOut) {
                    abandonConnection(client);
                }

                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('reports that the connection could not be claimed when the claim hook fails', databaseTest, async () => {
            const dedicated = dedicatedPool();
            const checkedOut: unknown[] = [];
            dedicated.on('acquire', client => {
                checkedOut.push(client);
            });

            try {
                await inScope({
                    onClaim: () => {
                        throw new Error('setting up the connection failed');
                    },
                }, async scoped => {
                    await expect(scoped.claim()).rejects.toThrow('Unable to claim connection');
                }, dedicated);
            } finally {
                for (const client of checkedOut) {
                    abandonConnection(client);
                }

                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('returns the connection to the pool when the fresh reset query fails', databaseTest, async () => {
            const dedicated = dedicatedPool();
            const checkedOut: unknown[] = [];
            dedicated.on('acquire', client => {
                checkedOut.push(client);
            });

            try {
                await inScope({freshResetQuery: 'RESET async_pool_no_such_setting'}, async scoped => {
                    await expect(scoped.claimFresh()).rejects.toThrow('Unable to claim connection');

                    expect(await capacityOf(dedicated)).toEqual('available');
                }, dedicated);
            } finally {
                for (const client of checkedOut) {
                    abandonConnection(client);
                }

                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('releases a connection the unit of work left claimed', databaseTest, async () => {
            const dedicated = dedicatedPool();
            let claimed: Connection | undefined = undefined;

            try {
                await inScope({}, async scoped => {
                    await scoped.runInIsolation(async () => {
                        // a unit of work that returns early, or throws, without releasing
                        claimed = await scoped.claim();
                    });

                    expect(await capacityOf(dedicated)).toEqual('available');
                }, dedicated);
            } finally {
                if (claimed !== undefined) {
                    abandonConnection(claimed);
                }

                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('releases the primary connections it handed out when primary connections are not shared', databaseTest, async () => {
            const dedicated = dedicatedPool();
            let handedOut: Connection | undefined = undefined;

            try {
                await inScope({keepPrimaryConnection: false}, async scoped => {
                    handedOut = await scoped.primary();
                    await handedOut.query('SELECT 1');
                    await scoped.flush();

                    expect(await capacityOf(dedicated)).toEqual('available');
                }, dedicated);
            } finally {
                if (handedOut !== undefined) {
                    abandonConnection(handedOut);
                }

                await outcomeWithin(dedicated.end(), 2000);
            }
        });
    });

    describe('transactions that do not go to plan', () => {
        test('reports a failure when the server discards an aborted transaction on commit', databaseTest, async () => {
            const identifier = randomUUID();

            await inScope({}, async scoped => {
                const outcome = scoped.runInTransaction(async () => {
                    const connection = await scoped.primary();
                    await connection.query(insertLedgerEntry, [identifier, 'first write']);

                    try {
                        // the conflict a repository handles itself, for instance while
                        // upserting: the transaction is aborted from here on
                        await connection.query(insertLedgerEntry, [identifier, 'conflicting write']);
                    } catch {
                        // handled by the caller
                    }
                });

                // Postgres discards the whole aborted transaction, first write included — that part
                // is not fixable. What must never happen is the caller being told it committed.
                await expect(outcome).rejects.toThrow('the server discarded it instead of committing');

                const result = await pool.query(selectLedgerEntry, [identifier]);

                expect(result.rows).toEqual([]);
            });
        });

        test('releases the transaction lock when the begin query fails', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});
            const context = asyncScopedContext();
            const scoped = new AsyncPgPool(dedicated, {beginQuery: 'BEGIN ISOLATION LEVEL NONSENSE'}, context);

            try {
                await context.run(async () => {
                    await expect(scoped.runInTransaction(async () => 'never runs')).rejects.toThrow();

                    // The transaction never started, so opening one has to be possible. Settlement is
                    // captured rather than awaited directly, so a lock that was never given back
                    // shows up as 'pending' instead of failing the test for the wrong reason.
                    const retry = await outcomeWithin(
                        scoped.begin('BEGIN').then(() => 'started', (error: unknown) => error),
                        1000,
                    );

                    expect(retry).toBe('started');

                    await scoped.abandon({rollbackOpenTransaction: true});
                });
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('stops using a connection it released when the begin query fails', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});
            const context = asyncScopedContext();
            const scoped = new AsyncPgPool(dedicated, {}, context);

            try {
                await context.run(async () => {
                    const before = await scoped.primary();
                    await before.query('SELECT 1');

                    await expect(scoped.begin('BEGIN ISOLATION LEVEL NONSENSE')).rejects.toThrow();

                    const after = await scoped.primary();
                    const queried = await after.query<{n: number}>('SELECT 1 as n').then(
                        result => result.rows[0].n,
                        () => 'the connection was no longer usable',
                    );

                    expect(queried).toEqual(1);
                });
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('reports the forgotten transaction when flushing', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});
            const context = asyncScopedContext();
            const scoped = new AsyncPgPool(dedicated, {}, context);

            try {
                await context.run(async () => {
                    await scoped.begin();

                    await expect(scoped.flush()).rejects.toThrow('a transaction was still open');

                    // Reporting is not enough on its own: the connection has to be back in the pool,
                    // otherwise the diagnostic just describes a leak.
                    expect(await capacityOf(dedicated)).toBe('available');
                });
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        /**
         * Queueing behind an active transaction is intended: two concurrent flows in one context
         * each get their turn, which "smoketest, concurrent does not deadlock" relies on. The
         * hazard is the flow that awaits a second transaction it would itself have to finalise,
         * which can never be satisfied. A configured wait turns that into a diagnosis.
         */
        test('reports a transaction that cannot be started within the configured wait', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});
            const context = asyncScopedContext();
            const scoped = new AsyncPgPool(dedicated, {transactionWaitTimeoutMs: 100}, context);

            try {
                await context.run(async () => {
                    await scoped.begin();

                    const nested = await outcomeWithin(
                        scoped.begin().then(() => 'started', () => 'refused'),
                        1000,
                    );

                    expect(nested).toBe('refused');

                    await scoped.abandon({rollbackOpenTransaction: true});
                });
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('keeps queueing indefinitely when no wait is configured', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});
            const context = asyncScopedContext();
            const scoped = new AsyncPgPool(dedicated, {}, context);

            try {
                await context.run(async () => {
                    const first = await scoped.begin();
                    const queued = scoped.begin();

                    expect(await outcomeWithin(queued, 100)).toBe(stillPending);

                    await scoped.commit(first);
                    await queued;

                    expect(scoped.inTransaction()).toBe(true);

                    await scoped.abandon({rollbackOpenTransaction: true});
                });
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('propagates the error of an isolated unit of work that forgot its transaction', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});
            const context = asyncScopedContext();
            const scoped = new AsyncPgPool(dedicated, {}, context);

            try {
                await context.run(async () => {
                    // The forgotten transaction makes the flush inside runInIsolation complain;
                    // that complaint must not replace the unit of work's own failure.
                    const outcome = scoped.runInIsolation(async () => {
                        await scoped.begin();

                        throw new Error('the unit of work failed');
                    });

                    await expect(outcome).rejects.toThrow('the unit of work failed');

                    // The complaint stepping aside must not mean the cleanup did: the
                    // isolated scope still has to give its connection back.
                    expect(await capacityOf(dedicated)).toBe('available');
                });
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('propagates the error of the unit of work when the rollback fails', databaseTest, async () => {
            const pool = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});

            try {
                await inScope({}, async scoped => {
                    await expect(scoped.runInTransaction(async () => {
                        const transaction = scoped.withTransaction();
                        ignoreConnectionErrors(pool, transaction);
                        // the server hangs up on the session while the unit of work runs
                        await transaction.query('SET idle_in_transaction_session_timeout = \'20ms\'');
                        await wait(300);

                        throw new Error('the unit of work failed');
                    })).rejects.toThrow('the unit of work failed');
                }, pool);
            } finally {
                await outcomeWithin(pool.end(), 2000);
            }
        });

        test('reports the failure that made the commit fail', databaseTest, async () => {
            const identifier = randomUUID();

            await inScope({}, async scoped => {
                const failure = await scoped.runInTransaction(async () => {
                    const connection = await scoped.primary();
                    // a constraint that only fires when the transaction commits
                    await connection.query(insertDeferredLedgerEntry, [identifier]);
                    await connection.query(insertDeferredLedgerEntry, [identifier]);
                }).then(() => undefined, (error: unknown) => error);

                expect((failure as {code?: string}).code).toEqual('23505');
            });
        });

        test('surfaces the failure of the release hook after committing', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});

            try {
                await inScope({
                    onRelease: () => {
                        throw new Error('the release hook failed');
                    },
                }, async scoped => {
                    await expect(scoped.runInTransaction(async () => 'persisted'))
                        .rejects.toThrow('the release hook failed');
                }, dedicated);
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('waits for idle connections to be released before reporting a flush as done', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});
            const released: string[] = [];

            try {
                await inScope({
                    keepConnections: 1,
                    maxIdleMs: 5000,
                    onRelease: async () => {
                        await wait(20);
                        released.push('released');
                    },
                }, async scoped => {
                    const connection = await scoped.claim();
                    await scoped.release(connection);
                    await scoped.flush();

                    expect(released).toEqual(['released']);
                }, dedicated);
            } finally {
                await wait(100);
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('fails the flush when an idle connection cannot be released', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});
            const escaped: unknown[] = [];
            const collectEscaped = (reason: unknown) => {
                escaped.push(reason);
            };
            process.on('unhandledRejection', collectEscaped);

            try {
                await inScope({
                    keepConnections: 1,
                    maxIdleMs: 5000,
                    onRelease: async () => {
                        await wait(20);

                        throw new Error('the release hook failed');
                    },
                }, async scoped => {
                    const connection = await scoped.claim();
                    await scoped.release(connection);

                    // Asserted separately from the unhandled rejection below: a flush that reports
                    // the failure and a flush that lets it escape are both "not fine", so a single
                    // assertion could not tell the two apart.
                    await expect(scoped.flush()).rejects.toThrow('the release hook failed');
                    await wait(100);

                    expect(escaped).toEqual([]);
                }, dedicated);
            } finally {
                await wait(50);
                process.off('unhandledRejection', collectEscaped);
                await outcomeWithin(dedicated.end(), 2000);
            }
        });
    });

    /**
     * Abandoning is for the scope whose end is not in the caller's hands: an HTTP request the client
     * may abort, where there is no reliable moment after the handler to flush. It has to work from a
     * place that can neither wait nor handle a rejection.
     */
    describe('connections whose session the server ends', () => {
        test('refuses to commit a transaction whose session ended', databaseTest, async () => {
            const dedicated = dedicatedPool({connectionTimeoutMillis: 2000});

            try {
                await inScope({}, async scoped => {
                    const transaction = await scoped.begin();
                    await endSessionOf(transaction);

                    await expect(scoped.commit(transaction)).rejects.toThrow(UnableToCommitTransaction);
                    expect(dedicated.totalCount).toEqual(0);
                }, dedicated);
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('accepts rolling back a transaction whose session ended, and lets the next one begin', databaseTest, async () => {
            const dedicated = dedicatedPool({connectionTimeoutMillis: 2000});

            try {
                await inScope({}, async scoped => {
                    const transaction = await scoped.begin();
                    await endSessionOf(transaction);

                    await expect(scoped.rollback(transaction)).resolves.toBeUndefined();

                    const next = outcomeWithin(scoped.runInTransaction(async () => 'next'), 2000);

                    expect(await next).toEqual('next');
                }, dedicated);
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('keeps the flow inside a transaction whose session ended until its owner finalises it', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});

            try {
                await inScope({}, async scoped => {
                    const transaction = await scoped.begin();
                    await endSessionOf(transaction);

                    expect(scoped.inTransaction()).toEqual(true);
                    await expect((await scoped.primary()).query('SELECT 1')).rejects.toThrow();

                    await scoped.rollback(transaction);
                }, dedicated);
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('hands back a claimed connection whose session ended', databaseTest, async () => {
            const dedicated = dedicatedPool({connectionTimeoutMillis: 2000});

            try {
                await inScope({}, async scoped => {
                    const connection = await scoped.claim();
                    await endSessionOf(connection);

                    expect(dedicated.totalCount).toEqual(0);
                    await expect(scoped.release(connection)).resolves.toBeUndefined();
                }, dedicated);
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('replaces a kept primary connection whose session ended', databaseTest, async () => {
            const dedicated = dedicatedPool({connectionTimeoutMillis: 2000});
            // Opened outside the scope, so the connection's events run outside of it too, as they do
            // for any connection another flow opened.
            (await dedicated.connect()).release();

            try {
                await inScope({}, async scoped => {
                    await endSessionOf(await scoped.primary());

                    const result = await (await scoped.primary()).query<{n: number}>('SELECT 1 AS n');

                    expect(result.rows[0]!.n).toEqual(1);
                }, dedicated);
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('abandoning a scope reports no failure for a transaction whose session ended', databaseTest, async () => {
            const dedicated = dedicatedPool({connectionTimeoutMillis: 2000});

            try {
                await inScope({}, async scoped => {
                    await endSessionOf(await scoped.begin());

                    expect(await scoped.abandon({rollbackOpenTransaction: true})).toEqual({
                        openTransaction: 'rolled-back',
                        releasedConnections: 0,
                        failures: [],
                    });
                }, dedicated);
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });
    });

    describe('abandoning a scope that cannot end itself', () => {
        test('waits for the open transaction to be committed, then ends the scope', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});
            const context = asyncScopedContext();
            const scoped = new AsyncPgPool(dedicated, {}, context);
            const identifier = randomUUID();

            try {
                await context.run(async () => {
                    // Stands in for the handler that is still running after the client disconnected:
                    // it holds the transaction, and abandon fires before it commits.
                    const transaction = await scoped.begin();
                    await transaction.query(insertLedgerEntry, [identifier, 'still-committing']);
                    const abandoned = scoped.abandon();

                    expect(await outcomeWithin(abandoned, 200)).toBe(stillPending);

                    // The owner runs on and commits, exactly as a disconnected request's handler does.
                    await scoped.commit(transaction);

                    expect(await abandoned).toEqual({openTransaction: 'finished', releasedConnections: 0, failures: []});
                    expect(scoped.wasFlushed()).toEqual(true);
                });

                const result = await pool.query(selectLedgerEntry, [identifier]);

                expect(result.rows).toEqual([{note: 'still-committing'}]);
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('ends the scope once the session of the open transaction ended', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});
            const context = asyncScopedContext();
            const scoped = new AsyncPgPool(dedicated, {}, context);

            try {
                await context.run(async () => {
                    const transaction = await scoped.begin();
                    const abandoned = scoped.abandon();
                    await endSessionOf(transaction);

                    expect(await outcomeWithin(abandoned, 2000)).toEqual({openTransaction: 'lost', releasedConnections: 0, failures: []});
                    expect(scoped.wasFlushed()).toEqual(true);
                });
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('refuses a transaction that would begin after the scope was abandoned', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});
            const context = asyncScopedContext();
            const scoped = new AsyncPgPool(dedicated, {}, context);

            try {
                await context.run(async () => {
                    const first = await scoped.begin();
                    const abandoned = scoped.abandon();
                    const second = scoped.begin();
                    void second.catch(() => undefined);

                    await scoped.commit(first);
                    await abandoned;

                    await expect(second).rejects.toThrow('already flushed');
                });
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('lets the flow finalise a transaction whose session ended after its scope was abandoned', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});
            const context = asyncScopedContext();
            const scoped = new AsyncPgPool(dedicated, {lockAfterFlush: false}, context);

            try {
                await context.run(async () => {
                    const transaction = await scoped.begin();
                    const abandoned = scoped.abandon();
                    await endSessionOf(transaction);
                    await abandoned;

                    await scoped.rollback(transaction);

                    expect(await outcomeWithin(scoped.runInTransaction(async () => 'next'), 2000)).toEqual('next');
                });
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('rolls the transaction back only when asked to reclaim the connection', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});
            const context = asyncScopedContext();
            const scoped = new AsyncPgPool(dedicated, {}, context);
            const identifier = randomUUID();

            try {
                await context.run(async () => {
                    const transaction = await scoped.begin();
                    await transaction.query(insertLedgerEntry, [identifier, 'abandoned']);

                    const outcome = await scoped.abandon({rollbackOpenTransaction: true});

                    expect(outcome.openTransaction).toBe('rolled-back');
                    expect(outcome.releasedConnections).toBe(1);
                    expect(outcome.failures).toEqual([]);
                    expect(await capacityOf(dedicated)).toBe('available');
                });

                const result = await pool.query(selectLedgerEntry, [identifier]);

                expect(result.rows).toEqual([]);
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('settles without waiting when asked to reclaim the connection', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});
            const context = asyncScopedContext();
            const scoped = new AsyncPgPool(dedicated, {}, context);

            try {
                await context.run(async () => {
                    const transaction = await scoped.begin();

                    // A flush would have queued behind the very transaction it is reporting on.
                    const outcome = await outcomeWithin(scoped.abandon({rollbackOpenTransaction: true}), 1000);

                    expect(outcome).not.toBe(stillPending);
                    expect(transaction).toBeDefined();
                });
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('reports a failing release hook instead of rejecting', databaseTest, async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});
            const context = asyncScopedContext();
            const scoped = new AsyncPgPool(dedicated, {
                onRelease: () => {
                    throw new Error('the release hook failed');
                },
                releaseHookOnError: true,
            }, context);

            try {
                await context.run(async () => {
                    await scoped.claim();

                    const outcome = await scoped.abandon();

                    expect(outcome.failures).toHaveLength(1);
                    expect(outcome.failures[0]).toBeInstanceOf(Error);
                    expect((outcome.failures[0] as Error).message).toContain('the release hook failed');
                });
            } finally {
                await outcomeWithin(dedicated.end(), 2000);
            }
        });

        test('abandoning twice is harmless', databaseTest, async () => {
            await inScope({}, async scoped => {
                await scoped.claim();

                const first = await scoped.abandon();
                const second = await scoped.abandon();

                expect(first.releasedConnections).toBe(1);
                expect(second).toEqual({openTransaction: 'none', releasedConnections: 0, failures: []});
            });
        });

        test('abandoning after a flush reports nothing left to do', databaseTest, async () => {
            await inScope({}, async scoped => {
                await scoped.claim();
                await scoped.flush();

                expect(await scoped.abandon()).toEqual({
                    openTransaction: 'none',
                    releasedConnections: 0,
                    failures: [],
                });
            });
        });

        test('abandoning a scope that never used the pool reports nothing', databaseTest, async () => {
            await inScope({}, async scoped => {
                expect(await scoped.abandon()).toEqual({
                    openTransaction: 'none',
                    releasedConnections: 0,
                    failures: [],
                });
            });
        });

    });

    describe('connection state that hooks maintain', () => {

        test('the release hook runs before the connection goes back to the pool', async () => {
            const dedicated = dedicatedPool({connectionTimeoutMillis: 2000});

            try {
                await inScope({onRelease: 'RESET app.tenant_id'}, async scoped => {
                    const connection = await scoped.claim();
                    await connection.query('SET app.tenant_id = \'first-tenant\'');
                    await scoped.release(connection);

                    // the pool has a single connection, so this is the same session
                    const reused = await scoped.claim();
                    const result = await reused.query<{tenant: string}>(
                        'SELECT current_setting(\'app.tenant_id\') as tenant',
                    );
                    await scoped.release(reused);

                    expect(result.rows[0].tenant).toEqual('');
                }, dedicated);
            } finally {
                await dedicated.end();
            }
        }, 20000);
    });

    describe('TransactionManagerUsingPg', () => {
        test('the transaction state follows begin and commit', async () => {
            await inScope({}, async scoped => {
                const manager = new TransactionManagerUsingPg(scoped);

                expect(manager.inTransaction()).toEqual(false);

                await manager.begin();

                expect(manager.inTransaction()).toEqual(true);

                await manager.commit();

                expect(manager.inTransaction()).toEqual(false);
            });
        }, 15000);

        test('the transaction state follows begin and rollback', async () => {
            await inScope({}, async scoped => {
                const manager = new TransactionManagerUsingPg(scoped);
                await manager.begin();

                expect(manager.inTransaction()).toEqual(true);

                await manager.rollback();

                expect(manager.inTransaction()).toEqual(false);
            });
        }, 15000);

        test('work of a successful unit of work is committed', async () => {
            const identifier = randomUUID();

            await inScope({}, async scoped => {
                const manager = new TransactionManagerUsingPg(scoped);

                const result = await manager.runInTransaction(async () => {
                    const connection = await scoped.primary();
                    await connection.query(insertLedgerEntry, [identifier, 'through the manager']);

                    return 'persisted';
                });

                expect(result).toEqual('persisted');
            });

            const result = await pool.query(selectLedgerEntry, [identifier]);

            expect(result.rows).toEqual([{note: 'through the manager'}]);
        }, 15000);

        test('work of a failing unit of work is rolled back and the failure reaches the caller', async () => {
            const identifier = randomUUID();
            const failure = new Error('the unit of work failed');

            await inScope({}, async scoped => {
                const manager = new TransactionManagerUsingPg(scoped);

                await expect(manager.runInTransaction(async () => {
                    const connection = await scoped.primary();
                    await connection.query(insertLedgerEntry, [identifier, 'through the manager']);

                    throw failure;
                })).rejects.toBe(failure);
            });

            const result = await pool.query(selectLedgerEntry, [identifier]);

            expect(result.rowCount).toEqual(0);
        }, 15000);

        test('an isolated transaction is committed independently of the transaction of its caller', async () => {
            const isolated = randomUUID();
            const ambient = randomUUID();

            await inScope({}, async scoped => {
                const manager = new TransactionManagerUsingPg(scoped);
                await manager.begin();
                const ambientTransaction = scoped.withTransaction();
                await ambientTransaction.query(insertLedgerEntry, [ambient, 'ambient']);

                await manager.runInIsolatedTransaction(async () => {
                    const connection = await scoped.primary();
                    await connection.query(insertLedgerEntry, [isolated, 'isolated']);
                });

                expect(manager.inTransaction()).toEqual(true);

                await manager.rollback();
            });

            const surviving = await pool.query<{identifier: string}>(
                `SELECT identifier FROM ${ledgerTable} WHERE identifier = ANY ($1::text[])`,
                [[isolated, ambient]],
            );

            expect(surviving.rows.map(row => row.identifier)).toEqual([isolated]);
        }, 15000);

        test('a second begin waits for the active transaction to finish', async () => {
            const dedicated = dedicatedPool({max: 2, connectionTimeoutMillis: 2000});

            try {
                await inScope({}, async scoped => {
                    const manager = new TransactionManagerUsingPg(scoped);
                    await manager.begin();
                    const secondBegin = manager.begin();

                    expect(await outcomeWithin(secondBegin, 100)).toBe(stillPending);

                    await manager.commit();
                    await secondBegin;

                    expect(manager.inTransaction()).toEqual(true);

                    await manager.commit();
                }, dedicated);
            } finally {
                await dedicated.end();
            }
        }, 20000);
    });
});
