import {Pool} from 'pg';
import {
    AsyncPgPool,
    transactionContextSlot,
    type AsyncPgPoolOptions,
    type Connection,
} from './index.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {composeContextSlotsForTesting, composeContextSlots} from '@deltic/context';
import {pgTestCredentials} from '../../pg-credentials.js';

describe('AsyncPgPool', () => {
    let pool: Pool;
    let provider: AsyncPgPool;
    const factoryWithStaticPool = (options: AsyncPgPoolOptions = {}) => new AsyncPgPool(pool, options);
    const factoryWithAsyncPool = (options: AsyncPgPoolOptions = {}) => {
        const context = composeContextSlotsForTesting([transactionContextSlot]);

        return new AsyncPgPool(pool, options, context);
    };

    beforeAll(async () => {
        pool = new Pool(pgTestCredentials);
    });

    afterAll(async () => {
        await pool.end();
    });

    afterEach(async () => {
        if (provider) {
            await provider.flushSharedContext();
        }
    });

    describe.each([
        ['pool, static transaction context', factoryWithStaticPool],
        ['pool, async transaction context', factoryWithAsyncPool],
    ] as const)('basics for %s', (_name, factory) => {
        beforeEach(() => {
            provider = factory({
                freshResetQuery: 'RESET ALL',
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

        test('smoketest, using an encapsulated transaction', async () => {
            let wasInTransaction: boolean = false;

            expect(provider.inTransaction()).toEqual(false);

            await provider.runInTransaction(async () => {
                wasInTransaction = provider.inTransaction();
            });

            expect(wasInTransaction).toEqual(true);
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

        test('shared context flushing errors when the transaction is still open', async () => {
            const transaction = await provider.begin();

            await expect(provider.flushSharedContext()).rejects.toThrow();

            await provider.rollback(transaction);
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
        const context = composeContextSlots([transactionContextSlot], new AsyncLocalStorage());

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
        const context = composeContextSlots([transactionContextSlot], new AsyncLocalStorage());

        const provider = new AsyncPgPool(pool, {}, context);

        let innerInTransaction = false;

        await provider.runInIsolatedTransaction(async () => {
            innerInTransaction = provider.inTransaction();
        });

        expect(innerInTransaction).toEqual(true);
    });
});
