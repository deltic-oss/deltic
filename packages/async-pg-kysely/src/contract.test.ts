import {Pool} from 'pg';
import Cursor from 'pg-cursor';
import {AsyncPgPool, asyncPgPoolContextSlot, type AsyncPgPoolOptions} from '@deltic/async-pg-pool';
import {composeContextSlots} from '@deltic/context';
import {AsyncLocalStorage} from 'node:async_hooks';
import {
    AsyncKyselyConnectionProvider,
    AsyncPgDialect,
    AsyncPgDriver,
    KyselyTransactionsNotSupported,
    pgConnectionSymbol,
} from './index.js';
import {pgTestCredentials} from '../../pg-credentials.js';
import {
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

        it('releaseConnection returns a connection acquired before a transaction began', async () => {
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
                });

                expect(idleAfterRelease).toBe(1);
            } finally {
                await dedicated.end();
            }
        });

        it('releaseConnection leaves the transaction connection to the transaction that ended meanwhile', async () => {
            const dedicated = new Pool({...pgTestCredentials, max: 2});
            const driverPool = scopedPool(dedicated, {keepPrimaryConnection: false});
            const driver = new AsyncPgDriver(driverPool);

            try {
                await driverPool.runInIsolation(async () => {
                    const transaction = await driverPool.begin();
                    const connection = await driver.acquireConnection();

                    // the transaction is finalised by another part of the flow while the query runs
                    await driverPool.commit(transaction);

                    await expect(driver.releaseConnection(connection)).resolves.toBeUndefined();
                });

                expect(dedicated.idleCount).toBe(dedicated.totalCount);
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
});
