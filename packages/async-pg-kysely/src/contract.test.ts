import {Pool} from 'pg';
import Cursor from 'pg-cursor';
import {AsyncPgPool, asyncPgPoolContextSlot, type AsyncPgPoolOptions} from '@deltic/async-pg-pool';
import {composeContextSlots} from '@deltic/context';
import {AsyncLocalStorage} from 'node:async_hooks';
import {
    AsyncKyselyConnectionProvider,
    AsyncPgConnection,
    AsyncPgDialect,
    AsyncPgDriver,
    KyselyTransactionsNotSupported,
    pgConnectionSymbol,
} from './index.js';
import {pgTestCredentials} from '../../pg-credentials.js';
import {
    CamelCasePlugin,
    PostgresAdapter,
    PostgresQueryCompiler,
    sql,
    type Generated,
    type Kysely,
} from 'kysely';

// -- Type definitions for test tables --

interface AccountsTable {
    id: Generated<number>;
    holder_name: string;
    balance: number;
}

interface DeferredTable {
    id: Generated<number>;
    slug: string;
}

interface DB {
    async_kysely_accounts: AccountsTable;
    async_kysely_deferred: DeferredTable;
}

interface CamelDB {
    asyncKyselyAccounts: {
        id: Generated<number>;
        holderName: string;
        balance: number;
    };
}

const createTables = `
    DROP TABLE IF EXISTS async_kysely_accounts;
    DROP TABLE IF EXISTS async_kysely_deferred;
    CREATE TABLE async_kysely_accounts (
        id SERIAL PRIMARY KEY,
        holder_name TEXT NOT NULL UNIQUE,
        balance INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE async_kysely_deferred (
        id SERIAL PRIMARY KEY,
        slug TEXT NOT NULL,
        CONSTRAINT async_kysely_deferred_slug_key UNIQUE (slug) DEFERRABLE INITIALLY DEFERRED
    );
`;

const dropTables = `
    DROP TABLE IF EXISTS async_kysely_ddl_probe;
    DROP TABLE IF EXISTS async_kysely_accounts;
    DROP TABLE IF EXISTS async_kysely_deferred;
`;

/**
 * An async-context-backed pool: unlike the default in-memory context store this
 * one gives every `runInIsolation` flow its own pool context, which is what a
 * server does per request.
 */
const scopedPool = (pool: Pool, options: AsyncPgPoolOptions = {}): AsyncPgPool =>
    new AsyncPgPool(pool, options, composeContextSlots([asyncPgPoolContextSlot], new AsyncLocalStorage()));

describe('AsyncKyselyConnectionProvider — usage scenarios', () => {
    let pool: Pool;
    let asyncPool: AsyncPgPool;
    let provider: AsyncKyselyConnectionProvider<DB>;

    beforeAll(async () => {
        pool = new Pool(pgTestCredentials);
        await pool.query(createTables);
    });

    afterAll(async () => {
        await pool.query(dropTables);
        await pool.end();
    });

    beforeEach(async () => {
        asyncPool = new AsyncPgPool(pool, {keepConnections: 0});
        provider = new AsyncKyselyConnectionProvider<DB>(asyncPool);
        await pool.query('TRUNCATE async_kysely_accounts, async_kysely_deferred RESTART IDENTITY');
    });

    afterEach(async () => {
        try {
            if (asyncPool.inTransaction()) {
                await asyncPool.rollback(asyncPool.withTransaction());
            }
        } catch {
            // Ignore errors during cleanup
        }

        try {
            await asyncPool.flush();
        } catch {
            // Ignore errors during cleanup
        }
    });

    // -- The reason this package exists: queries ride the ambient connection --

    describe('ambient connection routing', () => {
        test('a write through Kysely is visible to raw access on the same claimed connection', async () => {
            await asyncPool.runInTransaction(async () => {
                await provider.connection()
                    .insertInto('async_kysely_accounts')
                    .values({holder_name: 'Frank', balance: 100})
                    .execute();

                const onTransactionConnection = await asyncPool.withTransaction()
                    .query('SELECT holder_name FROM async_kysely_accounts');
                expect(onTransactionConnection.rows).toHaveLength(1);

                const onOtherConnection = await pool.query('SELECT holder_name FROM async_kysely_accounts');
                expect(onOtherConnection.rows).toHaveLength(0);
            });

            const afterCommit = await pool.query('SELECT holder_name FROM async_kysely_accounts');
            expect(afterCommit.rows).toHaveLength(1);
        });

        test('a raw write on the claimed connection is visible to Kysely', async () => {
            await asyncPool.runInTransaction(async () => {
                await asyncPool.withTransaction().query(
                    'INSERT INTO async_kysely_accounts (holder_name, balance) VALUES ($1, $2)',
                    ['Raw', 7],
                );

                const viaKysely = await provider.connection()
                    .selectFrom('async_kysely_accounts')
                    .selectAll()
                    .execute();

                expect(viaKysely).toHaveLength(1);
                expect(viaKysely[0].balance).toBe(7);
            });
        });

        test('rolling back discards writes made through both Kysely and raw access', async () => {
            await expect(asyncPool.runInTransaction(async () => {
                await provider.connection()
                    .insertInto('async_kysely_accounts')
                    .values({holder_name: 'Kysely', balance: 1})
                    .execute();
                await asyncPool.withTransaction().query(
                    'INSERT INTO async_kysely_accounts (holder_name, balance) VALUES ($1, $2)',
                    ['Raw', 2],
                );
                throw new Error('deliberate rollback');
            })).rejects.toThrow('deliberate rollback');

            const remaining = await pool.query('SELECT holder_name FROM async_kysely_accounts');
            expect(remaining.rows).toHaveLength(0);
        });

        test('concurrent async contexts do not see each other uncommitted writes', async () => {
            const contextPool = scopedPool(pool);
            const contextProvider = new AsyncKyselyConnectionProvider<DB>(contextPool);
            const labels = ['first', 'second'];
            let arrived = 0;
            let openTheGate = (): void => {};
            const gate = new Promise<void>((resolve) => {
                openTheGate = resolve;
            });
            const bothHaveWritten = async (): Promise<void> => {
                arrived += 1;

                if (arrived === labels.length) {
                    openTheGate();
                }

                return gate;
            };
            const visibleRows: Record<string, number> = {};

            await Promise.all(labels.map(async (label) => {
                await contextPool.runInIsolatedTransaction(async () => {
                    await contextProvider.connection()
                        .insertInto('async_kysely_accounts')
                        .values({holder_name: label, balance: 1})
                        .execute();

                    await bothHaveWritten();

                    const rows = await contextProvider.connection()
                        .selectFrom('async_kysely_accounts')
                        .selectAll()
                        .execute();
                    visibleRows[label] = rows.length;
                });
            }));

            expect(visibleRows).toEqual({first: 1, second: 1});

            const committed = await pool.query('SELECT holder_name FROM async_kysely_accounts ORDER BY holder_name');
            expect(committed.rows.map((row) => row.holder_name)).toEqual(['first', 'second']);
        });

        test('queries outside any async context scope fail instead of claiming a fresh connection', async () => {
            const contextPool = scopedPool(pool);
            const contextProvider = new AsyncKyselyConnectionProvider<DB>(contextPool);

            await expect(contextProvider.connection()
                .insertInto('async_kysely_accounts')
                .values({holder_name: 'Escaped', balance: 1})
                .execute(),
            ).rejects.toThrow('No transaction context available');

            const rows = await pool.query('SELECT holder_name FROM async_kysely_accounts');
            expect(rows.rows).toHaveLength(0);
        });

        test('queries after the pool context was flushed are refused', async () => {
            await provider.connection().selectFrom('async_kysely_accounts').selectAll().execute();
            await asyncPool.flush();

            await expect(provider.connection()
                .selectFrom('async_kysely_accounts')
                .selectAll()
                .execute(),
            ).rejects.toThrow('The pool context is already flushed');
        });
    });

    // -- The Kysely Driver contract --

    describe('driver contract', () => {
        test('releaseConnection returns the connection to the pool', async () => {
            const dedicated = new Pool({...pgTestCredentials, max: 2});
            const driverPool = scopedPool(dedicated, {keepPrimaryConnection: false});
            const driver = new AsyncPgDriver(driverPool);

            try {
                await driverPool.runInIsolation(async () => {
                    const connection = await driver.acquireConnection();
                    expect(dedicated.idleCount).toBe(0);

                    await driver.releaseConnection(connection);
                    expect(dedicated.idleCount).toBe(1);
                });
            } finally {
                await dedicated.end();
            }
        });

        // see .claude-work/issues/async-pg-kysely-driver-leaks-connection-when-transaction-starts.md
        it.fails('releaseConnection returns a connection acquired before a transaction began', async () => {
            const dedicated = new Pool({...pgTestCredentials, max: 2});
            const driverPool = scopedPool(dedicated, {keepPrimaryConnection: false});
            const driver = new AsyncPgDriver(driverPool);
            let idleAfterRelease = -1;

            try {
                await driverPool.runInIsolation(async () => {
                    const connection = await driver.acquireConnection();
                    const transaction = await driverPool.begin();

                    await driver.releaseConnection(connection);
                    idleAfterRelease = dedicated.idleCount;

                    await driverPool.commit(transaction);
                    // Hand the leaked connection back so the pool can be closed.
                    await driverPool.release((connection as AsyncPgConnection)[pgConnectionSymbol]);
                });

                expect(idleAfterRelease).toBe(1);
            } finally {
                await dedicated.end();
            }
        });

        test('the transaction methods refuse to run', async () => {
            const driver = new AsyncPgDriver(asyncPool);
            const connection = await driver.acquireConnection();

            await expect(driver.beginTransaction(connection, {}))
                .rejects.toThrow(KyselyTransactionsNotSupported);
            await expect(driver.commitTransaction(connection))
                .rejects.toThrow(KyselyTransactionsNotSupported);
            await expect(driver.rollbackTransaction(connection))
                .rejects.toThrow(KyselyTransactionsNotSupported);

            await driver.releaseConnection(connection);
        });

        test('init and destroy leave the pool untouched', async () => {
            const driver = new AsyncPgDriver(asyncPool);

            await driver.init();
            await driver.destroy();

            const connection = await driver.acquireConnection();
            const result = await connection.executeQuery<{one: number}>(
                sql<{one: number}>`SELECT 1 AS one`.compile(provider.connection()),
            );

            expect(result.rows[0].one).toBe(1);
            await driver.releaseConnection(connection);
        });

        test('the dialect provides the postgres compiler, adapter and introspector', async () => {
            const dialect = new AsyncPgDialect(asyncPool);

            expect(dialect.createDriver()).toBeInstanceOf(AsyncPgDriver);
            expect(dialect.createAdapter()).toBeInstanceOf(PostgresAdapter);
            expect(dialect.createQueryCompiler()).toBeInstanceOf(PostgresQueryCompiler);

            const tables = await provider.connection().introspection.getTables();
            const accounts = tables.find((table) => table.name === 'async_kysely_accounts');

            expect(accounts?.columns.map((column) => column.name))
                .toEqual(['id', 'holder_name', 'balance']);
        });
    });

    // -- Transaction lifecycle --

    describe('transaction lifecycle', () => {
        test('the begin query controls the isolation level', async () => {
            const trx = await provider.begin('BEGIN ISOLATION LEVEL SERIALIZABLE');

            const level = await sql<{transaction_isolation: string}>`SHOW transaction_isolation`.execute(trx);
            expect(level.rows[0].transaction_isolation).toBe('serializable');

            await provider.commit(trx);
        });

        test('withTransaction inside runInTransaction writes into the same transaction', async () => {
            await provider.runInTransaction(async () => {
                const trx = provider.withTransaction();

                expect((trx as unknown as Record<symbol, unknown>)[pgConnectionSymbol])
                    .toBe(asyncPool.withTransaction());

                await trx.insertInto('async_kysely_accounts')
                    .values({holder_name: 'Frank', balance: 1})
                    .execute();
            });

            const committed = await pool.query('SELECT holder_name FROM async_kysely_accounts');
            expect(committed.rows).toHaveLength(1);
        });

        test('committing an instance that is not a transaction is rejected', async () => {
            await expect(provider.commit(provider.connection()))
                .rejects.toThrow('Invalid transaction Kysely instance');
        });

        test('rolling back the same transaction twice is rejected', async () => {
            const trx = await provider.begin();
            await provider.rollback(trx);

            await expect(provider.rollback(trx))
                .rejects.toThrow('Trying to ROLLBACK a transaction that is NOT the known transaction');
        });

        test('rolling back the shared transaction from nested code fails the outer commit loudly', async () => {
            await expect(provider.runInTransaction(async () => {
                await provider.connection()
                    .insertInto('async_kysely_accounts')
                    .values({holder_name: 'Frank', balance: 1})
                    .execute();
                await provider.rollback(provider.withTransaction());
            })).rejects.toThrow('NOT the known transaction');

            const committed = await pool.query('SELECT holder_name FROM async_kysely_accounts');
            expect(committed.rows).toHaveLength(0);
        });

        test('a failure inside nested runInTransaction discards the whole transaction', async () => {
            await expect(provider.runInTransaction(async () => {
                await provider.connection()
                    .insertInto('async_kysely_accounts')
                    .values({holder_name: 'outer', balance: 1})
                    .execute();

                await provider.runInTransaction(async () => {
                    await provider.connection()
                        .insertInto('async_kysely_accounts')
                        .values({holder_name: 'inner', balance: 2})
                        .execute();
                    throw new Error('inner failed');
                });
            })).rejects.toThrow('inner failed');

            const committed = await pool.query('SELECT holder_name FROM async_kysely_accounts');
            expect(committed.rows).toHaveLength(0);
            expect(provider.inTransaction()).toBe(false);
        });

        test('savepoints let a nested step be discarded without losing the transaction', async () => {
            await provider.runInTransaction(async () => {
                const db = provider.connection();

                await db.insertInto('async_kysely_accounts')
                    .values({holder_name: 'before', balance: 1})
                    .execute();
                await sql`SAVEPOINT nested_step`.execute(db);

                await expect(db.insertInto('async_kysely_accounts')
                    .values({holder_name: 'before', balance: 2})
                    .execute(),
                ).rejects.toThrow('duplicate key value');

                await sql`ROLLBACK TO SAVEPOINT nested_step`.execute(db);

                await db.insertInto('async_kysely_accounts')
                    .values({holder_name: 'after', balance: 3})
                    .execute();
            });

            const committed = await pool.query('SELECT holder_name FROM async_kysely_accounts ORDER BY holder_name');
            expect(committed.rows.map((row) => row.holder_name)).toEqual(['after', 'before']);
        });

        test('a statement failure inside a transaction is rolled back and the connection recycled', async () => {
            const dedicated = new Pool({...pgTestCredentials, max: 2});
            const failingPool = scopedPool(dedicated);
            const failingProvider = new AsyncKyselyConnectionProvider<DB>(failingPool);

            try {
                await failingPool.runInIsolation(async () => {
                    const trx = await failingProvider.begin();
                    await trx.insertInto('async_kysely_accounts')
                        .values({holder_name: 'Frank', balance: 1})
                        .execute();

                    try {
                        await trx.insertInto('async_kysely_accounts')
                            .values({holder_name: 'Frank', balance: 2})
                            .execute();
                        expect.fail('the duplicate insert should have failed');
                    } catch (error) {
                        await failingProvider.rollback(trx, error);
                    }

                    // The ROLLBACK succeeded, so the session is clean and goes back to the pool.
                    expect(dedicated.totalCount).toBe(1);
                    expect(dedicated.idleCount).toBe(1);
                });
            } finally {
                await dedicated.end();
            }
        });

        it('runInTransaction reports the failure that made the commit fail', async () => {
            await expect(provider.runInTransaction(async () => {
                await provider.connection()
                    .insertInto('async_kysely_deferred')
                    .values({slug: 'duplicate'})
                    .execute();
                await provider.connection()
                    .insertInto('async_kysely_deferred')
                    .values({slug: 'duplicate'})
                    .execute();
            })).rejects.toThrow('duplicate key value violates unique constraint');
        });

        it('rolling back after a failed commit keeps the commit failure intact', async () => {
            const trx = await provider.begin();
            await trx.insertInto('async_kysely_deferred').values({slug: 'duplicate'}).execute();
            await trx.insertInto('async_kysely_deferred').values({slug: 'duplicate'}).execute();
            let commitFailure: unknown;

            try {
                await provider.commit(trx);
            } catch (error) {
                commitFailure = error;
                await provider.rollback(trx, error);
            }

            expect((commitFailure as Error).message).toContain('duplicate key value violates unique constraint');
        });

        it('committing a transaction Postgres already aborted is rejected', async () => {
            const trx = await provider.begin();
            await trx.insertInto('async_kysely_accounts')
                .values({holder_name: 'Frank', balance: 1})
                .execute();

            await expect(trx.insertInto('async_kysely_accounts')
                .values({holder_name: 'Frank', balance: 2})
                .execute(),
            ).rejects.toThrow('duplicate key value');

            await expect(provider.commit(trx)).rejects.toThrow();
        });

        // see .claude-work/issues/async-pg-kysely-committed-transaction-stays-usable.md
        it.fails('a committed transaction instance refuses further queries', async () => {
            const trx = await provider.begin();
            await trx.insertInto('async_kysely_accounts')
                .values({holder_name: 'committed', balance: 1})
                .execute();
            await provider.commit(trx);

            await expect(trx.insertInto('async_kysely_accounts')
                .values({holder_name: 'ghost', balance: 2})
                .execute(),
            ).rejects.toThrow();
        });
    });

    // -- Connection release on failure paths --

    describe('connection release', () => {
        let dedicated: Pool;
        let releasePool: AsyncPgPool;
        let releaseProvider: AsyncKyselyConnectionProvider<DB>;

        beforeAll(() => {
            dedicated = new Pool({...pgTestCredentials, max: 1});
        });

        afterAll(async () => {
            await dedicated.end();
        });

        beforeEach(() => {
            releasePool = scopedPool(dedicated, {keepPrimaryConnection: false});
            releaseProvider = new AsyncKyselyConnectionProvider<DB>(releasePool, {cursor: Cursor});
        });

        const failingQueries = [
            {
                name: 'a constraint violation',
                run: async (db: Kysely<DB>): Promise<unknown> => db.insertInto('async_kysely_accounts')
                    .values({holder_name: 'taken', balance: 1})
                    .execute(),
            },
            {
                name: 'an unknown table',
                run: async (db: Kysely<DB>): Promise<unknown> =>
                    sql`SELECT 1 FROM async_kysely_absent_table`.execute(db),
            },
            {
                name: 'a syntax error',
                run: async (db: Kysely<DB>): Promise<unknown> =>
                    sql`SELECT * FROMM async_kysely_accounts`.execute(db),
            },
            {
                name: 'a type mismatch',
                run: async (db: Kysely<DB>): Promise<unknown> => db.selectFrom('async_kysely_accounts')
                    .selectAll()
                    .where('balance', '=', 'not-a-number' as unknown as number)
                    .execute(),
            },
        ];

        test.each(failingQueries)(
            'the connection is released when a query fails with $name',
            async ({run}) => {
                await releasePool.runInIsolation(async () => {
                    await releaseProvider.connection()
                        .insertInto('async_kysely_accounts')
                        .values({holder_name: 'taken', balance: 0})
                        .execute();

                    for (let attempt = 0; attempt < 3; attempt++) {
                        await expect(run(releaseProvider.connection())).rejects.toThrow();
                    }

                    const rows = await releaseProvider.connection()
                        .selectFrom('async_kysely_accounts')
                        .selectAll()
                        .execute();

                    expect(rows).toHaveLength(1);
                });

                expect(dedicated.idleCount).toBe(1);
            },
            15000,
        );

        test('the connection is released when streaming is abandoned early', async () => {
            await releasePool.runInIsolation(async () => {
                await releaseProvider.connection()
                    .insertInto('async_kysely_accounts')
                    .values([
                        {holder_name: 'a', balance: 1},
                        {holder_name: 'b', balance: 2},
                        {holder_name: 'c', balance: 3},
                    ])
                    .execute();

                const seen: string[] = [];

                for await (const row of releaseProvider.connection()
                    .selectFrom('async_kysely_accounts')
                    .select(['holder_name'])
                    .orderBy('holder_name')
                    .stream(1)) {
                    seen.push(row.holder_name);
                    break;
                }

                expect(seen).toEqual(['a']);

                const rows = await releaseProvider.connection()
                    .selectFrom('async_kysely_accounts')
                    .selectAll()
                    .execute();
                expect(rows).toHaveLength(3);
            });

            expect(dedicated.idleCount).toBe(1);
        }, 15000);

        test('the connection is released when a streaming query fails', async () => {
            await releasePool.runInIsolation(async () => {
                await expect(async () => {
                    for await (const _chunk of releaseProvider.connection()
                        .selectFrom('async_kysely_accounts')
                        .select((eb) => [eb(sql<number>`1 / 0`, '>', 0).as('boom')])
                        .stream(1)) {
                        // unreachable
                    }
                }).rejects.toThrow('division by zero');

                const rows = await releaseProvider.connection()
                    .selectFrom('async_kysely_accounts')
                    .selectAll()
                    .execute();
                expect(rows).toEqual([]);
            });

            expect(dedicated.idleCount).toBe(1);
        }, 15000);

        test('the connection is released when streaming is not configured', async () => {
            const withoutCursor = new AsyncKyselyConnectionProvider<DB>(releasePool);

            await releasePool.runInIsolation(async () => {
                await expect(async () => {
                    for await (const _chunk of withoutCursor.connection()
                        .selectFrom('async_kysely_accounts')
                        .selectAll()
                        .stream(10)) {
                        // unreachable
                    }
                }).rejects.toThrow('\'cursor\' is not present');

                const rows = await withoutCursor.connection()
                    .selectFrom('async_kysely_accounts')
                    .selectAll()
                    .execute();
                expect(rows).toEqual([]);
            });

            expect(dedicated.idleCount).toBe(1);
        }, 15000);

        test('abandoning a stream inside a transaction keeps the transaction usable', async () => {
            await releasePool.runInIsolation(async () => {
                const trx = await releaseProvider.begin();

                await trx.insertInto('async_kysely_accounts')
                    .values([{holder_name: 'a', balance: 1}, {holder_name: 'b', balance: 2}])
                    .execute();

                for await (const _row of trx.selectFrom('async_kysely_accounts')
                    .select(['holder_name'])
                    .orderBy('holder_name')
                    .stream(1)) {
                    break;
                }

                await trx.insertInto('async_kysely_accounts')
                    .values({holder_name: 'c', balance: 3})
                    .execute();
                await releaseProvider.commit(trx);
            });

            const committed = await pool.query('SELECT holder_name FROM async_kysely_accounts ORDER BY holder_name');
            expect(committed.rows.map((row) => row.holder_name)).toEqual(['a', 'b', 'c']);
            expect(dedicated.idleCount).toBe(1);
        }, 15000);
    });

    // -- Kysely's own transaction API stays blocked --

    describe('kysely transaction guard', () => {
        test('a derived instance still refuses Kysely transactions', async () => {
            await expect(provider.connection()
                .withSchema('public')
                .transaction()
                .execute(async () => undefined),
            ).rejects.toThrow(KyselyTransactionsNotSupported);
        });

        test('a plugin-derived instance still refuses Kysely transactions', async () => {
            await expect(provider.connection()
                .withPlugin(new CamelCasePlugin())
                .transaction()
                .execute(async () => undefined),
            ).rejects.toThrow(KyselyTransactionsNotSupported);
        });

        // see .claude-work/issues/async-pg-kysely-nested-kysely-transaction-not-blocked.md
        it.fails('a nested Kysely transaction that rolls back discards its own writes', async () => {
            const trx = await provider.begin();
            await trx.insertInto('async_kysely_accounts')
                .values({holder_name: 'outer', balance: 1})
                .execute();

            await expect(trx.withSchema('public').transaction().execute(async (nested) => {
                await nested.insertInto('async_kysely_accounts')
                    .values({holder_name: 'nested', balance: 2})
                    .execute();
                throw new Error('nested failure');
            })).rejects.toThrow('nested failure');

            await provider.commit(trx);

            const committed = await pool.query('SELECT holder_name FROM async_kysely_accounts ORDER BY holder_name');
            expect(committed.rows.map((row) => row.holder_name)).toEqual(['outer']);
        });
    });

    // -- Provider lifecycle --

    describe('provider lifecycle', () => {
        test('queries are refused after destroy', async () => {
            await provider.connection().selectFrom('async_kysely_accounts').selectAll().execute();
            await provider.destroy();

            await expect(provider.connection()
                .selectFrom('async_kysely_accounts')
                .selectAll()
                .execute(),
            ).rejects.toThrow('driver has already been destroyed');
        });

        test('destroy is idempotent', async () => {
            await provider.connection().selectFrom('async_kysely_accounts').selectAll().execute();

            await provider.destroy();
            await expect(provider.destroy()).resolves.toBeUndefined();
        });

        // see .claude-work/issues/async-pg-kysely-destroy-before-first-query-has-no-effect.md
        it.fails('queries are refused after destroy even when nothing ran before it', async () => {
            const unused = new AsyncKyselyConnectionProvider<DB>(asyncPool);
            await unused.destroy();

            await expect(unused.connection()
                .selectFrom('async_kysely_accounts')
                .selectAll()
                .execute(),
            ).rejects.toThrow('driver has already been destroyed');
        });
    });

    // -- Result mapping --

    describe('result mapping', () => {
        test('a merge reports the number of affected rows', async () => {
            await provider.connection()
                .insertInto('async_kysely_accounts')
                .values({holder_name: 'Frank', balance: 10})
                .execute();

            const result = await sql`
                MERGE INTO async_kysely_accounts AS target
                USING (VALUES ('Frank', 25)) AS source(holder_name, balance)
                ON target.holder_name = source.holder_name
                WHEN MATCHED THEN UPDATE SET balance = source.balance
                WHEN NOT MATCHED THEN INSERT (holder_name, balance)
                    VALUES (source.holder_name, source.balance)
            `.execute(provider.connection());

            expect(result.numAffectedRows).toBe(1n);

            const updated = await provider.connection()
                .selectFrom('async_kysely_accounts')
                .select(['balance'])
                .executeTakeFirstOrThrow();
            expect(updated.balance).toBe(25);
        });

        test('an insert that hits a conflict reports zero affected rows', async () => {
            await provider.connection()
                .insertInto('async_kysely_accounts')
                .values({holder_name: 'Frank', balance: 10})
                .execute();

            const result = await provider.connection()
                .insertInto('async_kysely_accounts')
                .values({holder_name: 'Frank', balance: 99})
                .onConflict((oc) => oc.column('holder_name').doNothing())
                .executeTakeFirstOrThrow();

            expect(result.numInsertedOrUpdatedRows).toBe(0n);
        });

        test('an update matching nothing reports zero affected rows', async () => {
            const result = await provider.connection()
                .updateTable('async_kysely_accounts')
                .set({balance: 5})
                .where('holder_name', '=', 'nobody')
                .executeTakeFirstOrThrow();

            expect(result.numUpdatedRows).toBe(0n);
        });

        test('schema changes participate in the transaction', async () => {
            await expect(provider.runInTransaction(async () => {
                await provider.connection().schema
                    .createTable('async_kysely_ddl_probe')
                    .addColumn('id', 'serial', (column) => column.primaryKey())
                    .execute();
                throw new Error('deliberate rollback');
            })).rejects.toThrow('deliberate rollback');

            const exists = await pool.query<{reg: string | null}>(
                'SELECT to_regclass($1) AS reg',
                ['async_kysely_ddl_probe'],
            );
            expect(exists.rows[0].reg).toBeNull();
        });
    });

    // -- Security --

    describe('security', () => {
        test('interpolated values are bound, not inlined', async () => {
            await provider.connection()
                .insertInto('async_kysely_accounts')
                .values({holder_name: 'Frank', balance: 1})
                .execute();

            const payload = 'Frank\'; DROP TABLE async_kysely_accounts; --';
            const result = await sql<{holder_name: string}>`
                SELECT holder_name FROM async_kysely_accounts WHERE holder_name = ${payload}
            `.execute(provider.connection());

            expect(result.rows).toEqual([]);
            await expect(provider.connection()
                .selectFrom('async_kysely_accounts')
                .selectAll()
                .execute(),
            ).resolves.toHaveLength(1);
        });

        test('schema names are escaped as identifiers', async () => {
            await expect(provider.connection()
                .withSchema('public"; DROP TABLE async_kysely_accounts; --')
                .selectFrom('async_kysely_accounts')
                .selectAll()
                .execute(),
            ).rejects.toThrow('does not exist');

            const exists = await pool.query<{reg: string | null}>(
                'SELECT to_regclass($1) AS reg',
                ['async_kysely_accounts'],
            );
            expect(exists.rows[0].reg).toBe('async_kysely_accounts');
        });

        test('dynamically referenced columns are escaped as identifiers', async () => {
            const db = provider.connection();
            const payload = 'holder_name" FROM async_kysely_accounts; DROP TABLE async_kysely_accounts; --';

            await expect(db.selectFrom('async_kysely_accounts')
                .select(db.dynamic.ref(payload) as never)
                .execute(),
            ).rejects.toThrow('does not exist');

            const exists = await pool.query<{reg: string | null}>(
                'SELECT to_regclass($1) AS reg',
                ['async_kysely_accounts'],
            );
            expect(exists.rows[0].reg).toBe('async_kysely_accounts');
        });

        test('query failures do not disclose the statement or its parameters', async () => {
            await provider.connection()
                .insertInto('async_kysely_accounts')
                .values({holder_name: 'confidential-holder', balance: 1})
                .execute();

            try {
                await provider.connection()
                    .insertInto('async_kysely_accounts')
                    .values({holder_name: 'confidential-holder', balance: 2})
                    .execute();
                expect.fail('the duplicate insert should have failed');
            } catch (error) {
                const message = (error as Error).message;

                expect(message).toContain('duplicate key value');
                expect(message).not.toContain('confidential-holder');
                expect(message).not.toContain('insert into');
            }
        });
    });

    // -- Options are applied to every instance the provider hands out --

    describe('provider options', () => {
        test('plugins apply to lazy and transaction bound instances alike', async () => {
            const camelProvider = new AsyncKyselyConnectionProvider<CamelDB>(asyncPool, {
                plugins: [new CamelCasePlugin()],
            });

            await camelProvider.connection()
                .insertInto('asyncKyselyAccounts')
                .values({holderName: 'Frank', balance: 10})
                .execute();

            const lazy = await camelProvider.connection()
                .selectFrom('asyncKyselyAccounts')
                .select(['holderName', 'balance'])
                .executeTakeFirstOrThrow();
            expect(lazy).toEqual({holderName: 'Frank', balance: 10});

            const trx = await camelProvider.begin();
            const bound = await trx.selectFrom('asyncKyselyAccounts')
                .select(['holderName'])
                .executeTakeFirstOrThrow();
            expect(bound).toEqual({holderName: 'Frank'});
            await camelProvider.commit(trx);
        });

        test('the log config applies to lazy and transaction bound instances alike', async () => {
            const statements: string[] = [];
            const loggingProvider = new AsyncKyselyConnectionProvider<DB>(asyncPool, {
                log: (event) => {
                    statements.push(event.query.sql);
                },
            });

            await loggingProvider.connection()
                .insertInto('async_kysely_accounts')
                .values({holder_name: 'Frank', balance: 1})
                .execute();

            const trx = await loggingProvider.begin();
            await trx.selectFrom('async_kysely_accounts').selectAll().execute();
            await loggingProvider.commit(trx);

            expect(statements).toHaveLength(2);
            expect(statements[0]).toContain('insert into "async_kysely_accounts"');
            expect(statements[1]).toContain('select * from "async_kysely_accounts"');
        });
    });
});
