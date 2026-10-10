import {Pool} from 'pg';
import {
    AsyncPgPool,
    asyncPoolContext,
    type AsyncPgPoolOptions,
    type AsyncPoolContext,
} from '@deltic/async-pg-pool';
import type {Knex} from 'knex';
import {AsyncKnexConnectionProvider, extractPgConnection, type Transaction} from './index.js';
import {pgConnectionSymbol} from './transaction-wrapper.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {pgTestCredentials} from '../../pg-credentials.js';

const asyncLocalStorage = new AsyncLocalStorage<AsyncPoolContext>();
const setupContext = () => asyncLocalStorage.enterWith(asyncPoolContext());

interface DedicatedStack {
    pgPool: Pool;
    asyncPool: AsyncPgPool;
    provider: AsyncKnexConnectionProvider;
}

/**
 * Builds a provider on top of a pool that is not shared with any other test, so
 * pool capacity and connection lifecycle can be reasoned about without looking
 * at global database state. A leaked connection makes the next claim fail on the
 * connection timeout instead of hanging.
 */
const withDedicatedStack = async <R>(
    setup: {connections: number; options?: AsyncPgPoolOptions},
    use: (stack: DedicatedStack) => Promise<R>,
): Promise<R> => {
    const pgPool = new Pool({
        ...pgTestCredentials,
        max: setup.connections,
        connectionTimeoutMillis: 1000,
    });
    const asyncPool = new AsyncPgPool(pgPool, {keepConnections: 0, ...setup.options});
    const provider = new AsyncKnexConnectionProvider(asyncPool);

    try {
        return await use({pgPool, asyncPool, provider});
    } finally {
        // Best effort: a leaked transaction lock makes flush() block forever.
        await settlesWithin(asyncPool.flush(), 500);
        await pgPool.end().catch(() => undefined);
    }
};

/**
 * Resolves to 'settled' or 'timed out' without ever leaving the promise
 * unhandled, so a deadlock surfaces as a failed assertion instead of a hang.
 */
const settlesWithin = async (promise: PromiseLike<unknown>, milliseconds: number): Promise<'settled' | 'timed out'> => {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const expiry = new Promise<'timed out'>(resolve => {
        timer = setTimeout(() => resolve('timed out'), milliseconds);
    });

    try {
        return await Promise.race([
            promise.then(
                () => 'settled' as const,
                () => 'settled' as const,
            ),
            expiry,
        ]);
    } finally {
        clearTimeout(timer);
    }
};

const rejectionOf = async (promise: PromiseLike<unknown>): Promise<Error> => {
    try {
        await promise;
    } catch (error) {
        return error as Error;
    }

    throw new Error('Expected the promise to reject, but it resolved.');
};

describe('AsyncKnexConnectionProvider', () => {
    let pool: Pool;
    let asyncPool: AsyncPgPool;
    let provider: AsyncKnexConnectionProvider;
    const tableName = 'async_knex_test';
    const postsTable = 'async_knex_posts';

    beforeAll(async () => {
        pool = new Pool(pgTestCredentials);

        // Create test tables
        await pool.query(`
            DROP TABLE IF EXISTS ${postsTable};
            DROP TABLE IF EXISTS ${tableName};
            CREATE TABLE ${tableName} (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE,
                age INTEGER,
                active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE ${postsTable} (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES ${tableName}(id),
                title TEXT NOT NULL,
                content TEXT,
                published BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
    });

    afterAll(async () => {
        await pool.query(`DROP TABLE IF EXISTS ${postsTable}`);
        await pool.query(`DROP TABLE IF EXISTS ${tableName}`);
        await pool.end();
    });

    beforeEach(async () => {
        asyncPool = new AsyncPgPool(pool, {keepConnections: 0});
        provider = new AsyncKnexConnectionProvider(asyncPool);

        setupContext();
        // Clear tables before each test
        await pool.query(`TRUNCATE ${postsTable}, ${tableName} RESTART IDENTITY CASCADE`);
    });

    afterEach(async () => {
        // Ensure no dangling transactions
        if (provider.inTransaction()) {
            try {
                await provider.rollback(provider.withTransaction());
            } catch {
                // Ignore errors during cleanup
            }
        }
        await asyncPool.flush();
    });

    describe('basic queries', () => {
        test('SELECT with empty table returns empty array', async () => {
            const result = await provider.connection().select('*').from(tableName);

            expect(result).toEqual([]);
        });

        test('INSERT and SELECT a single row', async () => {
            await provider.connection()(tableName).insert({name: 'John', email: 'john@example.com', age: 30});

            const result = await provider.connection().select('*').from(tableName);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'John',
                email: 'john@example.com',
                age: 30,
            });
        });

        test('INSERT with onConflict().ignore()', async () => {
            await provider.connection()(tableName).insert({name: 'Conflict', email: 'conflict@example.com', age: 30});

            // Insert again with same unique email — should be ignored
            await provider
                .connection()(tableName)
                .insert({name: 'Conflict Duplicate', email: 'conflict@example.com', age: 31})
                .onConflict('email')
                .ignore();

            const result = await provider.connection().select('*').from(tableName);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'Conflict',
                email: 'conflict@example.com',
                age: 30,
            });
        });

        test('INSERT with onConflict().merge()', async () => {
            await provider.connection()(tableName).insert({name: 'Merge', email: 'merge@example.com', age: 30});

            // Insert again with same unique email — should merge (upsert)
            await provider
                .connection()(tableName)
                .insert({name: 'Merge Updated', email: 'merge@example.com', age: 31})
                .onConflict('email')
                .merge();

            const result = await provider.connection().select('*').from(tableName);

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'Merge Updated',
                email: 'merge@example.com',
                age: 31,
            });
        });

        test('INSERT with returning', async () => {
            const [inserted] = await provider
                .connection()(tableName)
                .insert({name: 'Jane', email: 'jane@example.com'})
                .returning('*');

            expect(inserted).toMatchObject({
                id: 1,
                name: 'Jane',
                email: 'jane@example.com',
            });
        });

        test('UPDATE rows', async () => {
            await provider.connection()(tableName).insert({name: 'Bob', email: 'bob@example.com', age: 25});

            const updated = await provider
                .connection()(tableName)
                .where('email', 'bob@example.com')
                .update({age: 26})
                .returning('*');

            expect(updated[0].age).toBe(26);
        });

        test('DELETE rows', async () => {
            await provider.connection()(tableName).insert([
                {name: 'User1', email: 'user1@example.com'},
                {name: 'User2', email: 'user2@example.com'},
            ]);

            const deleted = await provider.connection().table(tableName).where('name', 'User1').delete();

            expect(deleted).toBe(1);

            const remaining = await provider.connection().select('*').from(tableName);
            expect(remaining).toHaveLength(1);
            expect(remaining[0].name).toBe('User2');
        });
    });

    describe('query building', () => {
        beforeEach(async () => {
            await provider.connection()(tableName).insert([
                {name: 'Alice', email: 'alice@example.com', age: 25, active: true},
                {name: 'Bob', email: 'bob@example.com', age: 30, active: true},
                {name: 'Charlie', email: 'charlie@example.com', age: 35, active: false},
                {name: 'Diana', email: 'diana@example.com', age: 25, active: true},
            ]);
        });

        test('WHERE clause', async () => {
            const result = await provider.connection().select('name').from(tableName).where('age', 25);

            expect(result).toHaveLength(2);
            expect(result.map((r: any) => r.name).sort()).toEqual(['Alice', 'Diana']);
        });

        test('WHERE with operators', async () => {
            const result = await provider.connection().select('name').from(tableName).where('age', '>', 28);

            expect(result).toHaveLength(2);
            expect(result.map((r: any) => r.name).sort()).toEqual(['Bob', 'Charlie']);
        });

        test('multiple WHERE conditions', async () => {
            const result = await provider
                .connection()
                .select('name')
                .from(tableName)
                .where('age', 25)
                .where('active', true);

            expect(result).toHaveLength(2);
        });

        test('orWhere clause', async () => {
            const result = await provider
                .connection()
                .select('name')
                .from(tableName)
                .where('name', 'Alice')
                .orWhere('name', 'Bob');

            expect(result).toHaveLength(2);
        });

        test('ORDER BY', async () => {
            const result = await provider.connection().select('name').from(tableName).orderBy('age', 'desc');

            expect(result.map((r: any) => r.name)).toEqual(['Charlie', 'Bob', 'Alice', 'Diana']);
        });

        test('LIMIT', async () => {
            const result = await provider.connection().select('name').from(tableName).orderBy('name').limit(2);

            expect(result).toHaveLength(2);
            expect(result.map((r: any) => r.name)).toEqual(['Alice', 'Bob']);
        });

        test('OFFSET', async () => {
            const result = await provider.connection().select('name').from(tableName).orderBy('name').limit(2).offset(1);

            expect(result).toHaveLength(2);
            expect(result.map((r: any) => r.name)).toEqual(['Bob', 'Charlie']);
        });

        test('first() returns single row', async () => {
            const result = await provider.connection().first('name').from(tableName).orderBy('name');

            expect(result).toMatchObject({name: 'Alice'});
        });

        test('pluck() returns array of values', async () => {
            const result = await provider.connection().pluck('name').from(tableName).orderBy('name');

            expect(result).toEqual(['Alice', 'Bob', 'Charlie', 'Diana']);
        });

        test('count()', async () => {
            const result = (await provider.connection().count('* as total').from(tableName)) as {total: string}[];

            expect(result[0].total).toBe('4');
        });

        test('count() with where', async () => {
            const result = (await provider.connection().count('* as total').from(tableName).where('active', true)) as {
                total: string;
            }[];

            expect(result[0].total).toBe('3');
        });

        test('GROUP BY with aggregate', async () => {
            const result = await provider
                .connection()
                .select('active')
                .count('* as count')
                .from(tableName)
                .groupBy('active')
                .orderBy('active');

            expect(result).toHaveLength(2);
            expect(result[0]).toMatchObject({active: false, count: '1'});
            expect(result[1]).toMatchObject({active: true, count: '3'});
        });

        test('whereIn clause', async () => {
            const result = await provider
                .connection()
                .select('name')
                .from(tableName)
                .whereIn('name', ['Alice', 'Bob'])
                .orderBy('name');

            expect(result.map((r: any) => r.name)).toEqual(['Alice', 'Bob']);
        });

        test('whereNull and whereNotNull', async () => {
            // Insert a row with null age
            await provider.connection()(tableName).insert({name: 'NoAge', email: 'noage@example.com', age: null});

            const nullAge = await provider.connection().select('name').from(tableName).whereNull('age');

            expect(nullAge).toHaveLength(1);
            expect(nullAge[0].name).toBe('NoAge');

            const notNullAge = await provider.connection().select('name').from(tableName).whereNotNull('age');
            expect(notNullAge).toHaveLength(4);
        });
    });

    describe('subquery in from', () => {
        beforeEach(async () => {
            await provider.connection()(tableName).insert([
                {name: 'Alice', email: 'alice@example.com', age: 25, active: true},
                {name: 'Bob', email: 'bob@example.com', age: 30, active: true},
                {name: 'Charlie', email: 'charlie@example.com', age: 35, active: false},
            ]);
        });

        test('from() with a query builder wraps in parentheses', async () => {
            const subquery = provider.connection().select('name', 'age').from(tableName).where('active', true).as('active_users');

            const result = await provider.connection().select('name').from(subquery).orderBy('name');

            expect(result).toHaveLength(2);
            expect(result.map((r: any) => r.name)).toEqual(['Alice', 'Bob']);
        });

        test('from() with subquery from separate connection() calls', async () => {
            const connectionA = provider.connection();
            const connectionB = provider.connection();

            const subquery = connectionA.select('name', 'age').from(tableName).where('active', true).as('active_users');
            const result = await connectionB.select('name').from(subquery).orderBy('name');

            expect(result).toHaveLength(2);
            expect(result.map((r: any) => r.name)).toEqual(['Alice', 'Bob']);
        });

        test('toSQL() with subquery in from()', () => {
            const subquery = provider.connection().select('name', 'age').from(tableName).where('active', true).as('active_users');

            const sql = provider.connection().select('name').from(subquery).toSQL();

            expect(sql.sql).toContain('(');
            expect(sql.sql).toContain(') as');
        });
    });

    describe('raw queries', () => {
        test('raw SELECT query', async () => {
            await provider.connection()(tableName).insert({name: 'Test', email: 'test@example.com'});

            const result = await provider.connection().raw(`SELECT name FROM ${tableName} WHERE email = ?`, [
                'test@example.com',
            ]);

            expect(result.rows).toHaveLength(1);
            expect(result.rows[0].name).toBe('Test');
        });

        test('raw query with named bindings', async () => {
            await provider.connection()(tableName).insert({name: 'Named', email: 'named@example.com', age: 42});

            const result = await provider.connection().raw(`SELECT * FROM ${tableName} WHERE age = :age`, {age: 42});

            expect(result.rows).toHaveLength(1);
            expect(result.rows[0].name).toBe('Named');
        });
    });

    describe('toSQL() without connection', () => {
        test('toSQL() returns query without acquiring connection', async () => {
            const query = provider.connection().select('*').from(tableName).where('id', 1);

            const sql = query.toSQL();

            expect(sql.sql).toContain('select');
            expect(sql.sql).toContain(tableName);
            expect(sql.bindings).toEqual([1]);
        });

        test('toSQL() works with onConflict().ignore()', async () => {
            const query = provider
                .connection()(tableName)
                .insert({name: 'Test', email: 'test@example.com'})
                .onConflict('email')
                .ignore();

            const sql = query.toSQL();

            expect(sql.sql).toContain('insert');
            expect(sql.sql).toContain('on conflict');
        });

        test('toString() returns query string', async () => {
            const query = provider.connection().select('*').from(tableName).where('id', 1);

            const sql = query.toString();

            expect(sql).toContain('select');
            expect(sql).toContain(tableName);
        });
    });

    describe('callable syntax', () => {
        test('connection()(tableName) syntax works', async () => {
            await provider.connection()(tableName).insert({name: 'Callable', email: 'callable@example.com'});

            const result = await provider.connection()(tableName).select('name').where('email', 'callable@example.com');

            expect(result[0].name).toBe('Callable');
        });
    });

    describe('transactions', () => {
        test('begin and commit', async () => {
            const trx = await provider.begin();

            expect(provider.inTransaction()).toBe(true);

            await trx(tableName).insert({name: 'TrxTest', email: 'trx@example.com'});

            await provider.commit(trx);

            expect(provider.inTransaction()).toBe(false);

            // Verify data persisted
            const result = await provider.connection().select('*').from(tableName);
            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('TrxTest');
        });

        test('begin and rollback', async () => {
            const trx = await provider.begin();

            await trx(tableName).insert({name: 'RollbackTest', email: 'rollback@example.com'});

            await provider.rollback(trx);

            expect(provider.inTransaction()).toBe(false);

            // Verify data was rolled back
            const result = await provider.connection().select('*').from(tableName);
            expect(result).toHaveLength(0);
        });

        test('transaction with onConflict().ignore()', async () => {
            const trx = await provider.begin();

            await trx(tableName).insert({name: 'TrxConflict', email: 'trxconflict@example.com', age: 30});

            // Insert again with same unique email — should be ignored
            await trx(tableName)
                .insert({name: 'TrxConflict Duplicate', email: 'trxconflict@example.com', age: 31})
                .onConflict('email')
                .ignore();

            await provider.commit(trx);

            const result = await provider.connection().select('*').from(tableName);
            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({
                name: 'TrxConflict',
                email: 'trxconflict@example.com',
                age: 30,
            });
        });

        test('transaction with multiple operations', async () => {
            const trx = await provider.begin();

            await trx(tableName).insert({name: 'User1', email: 'user1@example.com', age: 20});
            await trx(tableName).insert({name: 'User2', email: 'user2@example.com', age: 30});
            await trx(tableName).where('name', 'User1').update({age: 25});

            await provider.commit(trx);

            const users = await provider.connection().select('*').from(tableName).orderBy('name');
            expect(users).toHaveLength(2);
            expect(users[0]).toMatchObject({name: 'User1', age: 25});
            expect(users[1]).toMatchObject({name: 'User2', age: 30});
        });

        test('transaction isolation - changes not visible until commit', async () => {
            const trx = await provider.begin();

            await trx(tableName).insert({name: 'Isolated', email: 'isolated@example.com'});

            // Query from outside transaction using raw pool (not via provider which would use same connection)
            const outsideResult = await pool.query(`SELECT * FROM ${tableName} WHERE name = 'Isolated'`);
            expect(outsideResult.rows).toHaveLength(0);

            await provider.commit(trx);

            // Now visible
            const afterCommit = await pool.query(`SELECT * FROM ${tableName} WHERE name = 'Isolated'`);
            expect(afterCommit.rows).toHaveLength(1);
        });

        test('transaction raw queries', async () => {
            const trx = await provider.begin();

            await trx.raw(`INSERT INTO ${tableName} (name, email) VALUES (?, ?)`, ['RawTrx', 'rawtrx@example.com']);

            const result = await trx.raw(`SELECT name FROM ${tableName} WHERE email = ?`, ['rawtrx@example.com']);
            expect(result.rows[0].name).toBe('RawTrx');

            await provider.commit(trx);
        });

        test('withTransaction() returns a wrapper bound to the active transaction', async () => {
            const trx = await provider.begin();

            const currentTrx = provider.withTransaction();
            expect((currentTrx as any)[pgConnectionSymbol]).toBe((trx as any)[pgConnectionSymbol]);

            await provider.commit(trx);
        });

        test('withTransaction() throws when not in transaction', () => {
            expect(() => provider.withTransaction()).toThrow('no transaction was active');
        });

        test('custom BEGIN query', async () => {
            const trx = await provider.begin('BEGIN ISOLATION LEVEL SERIALIZABLE');

            await trx(tableName).insert({name: 'Serializable', email: 'serial@example.com'});

            await provider.commit(trx);

            const result = await provider.connection().select('*').from(tableName);
            expect(result).toHaveLength(1);
        });
    });

    describe('runInTransaction', () => {
        test('auto-commits on success', async () => {
            const result = await provider.runInTransaction(async () => {
                await provider.connection()(tableName).insert({name: 'AutoCommit', email: 'auto@example.com'});
                return 'success';
            });

            expect(result).toBe('success');

            const rows = await provider.connection().select('*').from(tableName);
            expect(rows).toHaveLength(1);
        });

        test('auto-rollbacks on error', async () => {
            await expect(
                provider.runInTransaction(async () => {
                    await provider.connection()(tableName).insert({name: 'AutoRollback', email: 'rollback@example.com'});
                    throw new Error('Intentional error');
                }),
            ).rejects.toThrow('Intentional error');

            const rows = await provider.connection().select('*').from(tableName);
            expect(rows).toHaveLength(0);
        });

        test('nested runInTransaction uses existing transaction', async () => {
            await provider.runInTransaction(async () => {
                await provider.connection()(tableName).insert({name: 'Outer', email: 'outer@example.com'});

                await provider.runInTransaction(async () => {
                    await provider.connection()(tableName).insert({name: 'Inner', email: 'inner@example.com'});
                });
            });

            const rows = await provider.connection().select('*').from(tableName);
            expect(rows).toHaveLength(2);
        });
    });

    describe('connection lifecycle', () => {
        test('connection is released after await completes', async () => {
            // This test verifies that connections are properly released
            // by making multiple sequential queries (which would fail if connections leaked)
            for (let i = 0; i < 10; i++) {
                await provider.connection().select('*').from(tableName);
            }

            // If we got here without hanging, connections are being released properly
            expect(true).toBe(true);
        });

        test('connection is released even on query error', async () => {
            // Try a query that will fail
            await expect(provider.connection().select('*').from('nonexistent_table_xyz')).rejects.toThrow();

            // Should still be able to make more queries
            const result = await provider.connection().select('*').from(tableName);
            expect(result).toEqual([]);
        });
    });

    describe('chained query methods', () => {
        beforeEach(async () => {
            await provider.connection()(tableName).insert([
                {name: 'Alice', email: 'alice@example.com', age: 25},
                {name: 'Bob', email: 'bob@example.com', age: 30},
            ]);
        });

        test('select specific columns', async () => {
            const result = await provider.connection().select('name', 'age').from(tableName).orderBy('name');

            expect(result[0]).toMatchObject({name: 'Alice', age: 25});
            expect(result[0]).not.toHaveProperty('email');
        });

        test('select with alias', async () => {
            const result = await provider
                .connection()
                .select('name as userName', 'age as userAge')
                .from(tableName)
                .first();

            expect(result).toHaveProperty('userName');
            expect(result).toHaveProperty('userAge');
        });

        test('distinct', async () => {
            await provider.connection()(tableName).insert({name: 'Alice', email: 'alice2@example.com', age: 25});

            const result = await provider.connection().distinct('name').from(tableName).orderBy('name');

            expect(result).toHaveLength(2);
            expect(result.map((r: any) => r.name)).toEqual(['Alice', 'Bob']);
        });
    });

    describe('joins', () => {
        beforeEach(async () => {
            // Insert test users
            await provider.connection()(tableName).insert([
                {name: 'Alice', email: 'alice@example.com', age: 25},
                {name: 'Bob', email: 'bob@example.com', age: 30},
                {name: 'Charlie', email: 'charlie@example.com', age: 35},
            ]);

            // Insert test posts
            await provider.connection()(postsTable).insert([
                {user_id: 1, title: 'Alice Post 1', content: 'Content 1', published: true},
                {user_id: 1, title: 'Alice Post 2', content: 'Content 2', published: false},
                {user_id: 2, title: 'Bob Post 1', content: 'Content 3', published: true},
                // Charlie has no posts
            ]);
        });

        test('inner join', async () => {
            const result = await provider
                .connection()
                .select(`${tableName}.name`, `${postsTable}.title`)
                .from(tableName)
                .join(postsTable, `${tableName}.id`, `${postsTable}.user_id`)
                .orderBy(`${postsTable}.title`);

            expect(result).toHaveLength(3);
            expect(result[0]).toMatchObject({name: 'Alice', title: 'Alice Post 1'});
            expect(result[1]).toMatchObject({name: 'Alice', title: 'Alice Post 2'});
            expect(result[2]).toMatchObject({name: 'Bob', title: 'Bob Post 1'});
        });

        test('left join', async () => {
            const result = await provider
                .connection()
                .select(`${tableName}.name`, `${postsTable}.title`)
                .from(tableName)
                .leftJoin(postsTable, `${tableName}.id`, `${postsTable}.user_id`)
                .orderBy(`${tableName}.name`);

            expect(result).toHaveLength(4); // Alice (2 posts), Bob (1 post), Charlie (null)
            expect(result.filter((r: any) => r.name === 'Alice')).toHaveLength(2);
            expect(result.filter((r: any) => r.name === 'Bob')).toHaveLength(1);
            expect(result.filter((r: any) => r.name === 'Charlie')).toHaveLength(1);
            expect(result.find((r: any) => r.name === 'Charlie').title).toBeNull();
        });

        test('right join', async () => {
            const result = await provider
                .connection()
                .select(`${tableName}.name`, `${postsTable}.title`)
                .from(postsTable)
                .rightJoin(tableName, `${tableName}.id`, `${postsTable}.user_id`)
                .orderBy(`${tableName}.name`);

            expect(result).toHaveLength(4); // Same as left join from other direction
            expect(result.find((r: any) => r.name === 'Charlie').title).toBeNull();
        });

        test('join with additional where clause', async () => {
            const result = await provider
                .connection()
                .select(`${tableName}.name`, `${postsTable}.title`)
                .from(tableName)
                .join(postsTable, `${tableName}.id`, `${postsTable}.user_id`)
                .where(`${postsTable}.published`, true)
                .orderBy(`${postsTable}.title`);

            expect(result).toHaveLength(2);
            expect(result[0]).toMatchObject({name: 'Alice', title: 'Alice Post 1'});
            expect(result[1]).toMatchObject({name: 'Bob', title: 'Bob Post 1'});
        });

        test('join with callback for complex conditions', async () => {
            const result = await provider
                .connection()
                .select(`${tableName}.name`, `${postsTable}.title`)
                .from(tableName)
                .join(postsTable, function () {
                    this.on(`${tableName}.id`, '=', `${postsTable}.user_id`).andOn(`${postsTable}.published`, '=', provider.connection().raw('?', [true]));
                })
                .orderBy(`${postsTable}.title`);

            expect(result).toHaveLength(2);
        });

        test('multiple joins', async () => {
            // Create a comments table for this test
            await pool.query(`
                CREATE TABLE IF NOT EXISTS async_knex_comments (
                    id SERIAL PRIMARY KEY,
                    post_id INTEGER REFERENCES ${postsTable}(id),
                    body TEXT NOT NULL
                )
            `);

            await provider.connection().table('async_knex_comments').insert([
                {post_id: 1, body: 'Great post!'},
                {post_id: 1, body: 'Thanks for sharing'},
            ]);

            const result = await provider
                .connection()
                .select(`${tableName}.name`, `${postsTable}.title`, 'async_knex_comments.body')
                .from(tableName)
                .join(postsTable, `${tableName}.id`, `${postsTable}.user_id`)
                .join('async_knex_comments', `${postsTable}.id`, 'async_knex_comments.post_id')
                .orderBy('async_knex_comments.body');

            expect(result).toHaveLength(2);
            expect(result[0]).toMatchObject({name: 'Alice', title: 'Alice Post 1', body: 'Great post!'});
            expect(result[1]).toMatchObject({name: 'Alice', title: 'Alice Post 1', body: 'Thanks for sharing'});

            // Cleanup
            await pool.query('DROP TABLE IF EXISTS async_knex_comments');
        });

        test('join in transaction', async () => {
            const trx = await provider.begin();

            const result = await trx
                .select(`${tableName}.name`, `${postsTable}.title`)
                .from(tableName)
                .join(postsTable, `${tableName}.id`, `${postsTable}.user_id`)
                .where(`${postsTable}.published`, true);

            await provider.commit(trx);

            expect(result).toHaveLength(2);
        });

        test('leftOuterJoin alias', async () => {
            const result = await provider
                .connection()
                .select(`${tableName}.name`)
                .from(tableName)
                .leftOuterJoin(postsTable, `${tableName}.id`, `${postsTable}.user_id`)
                .whereNull(`${postsTable}.id`);

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Charlie');
        });
    });

    describe('query cloning', () => {
        beforeEach(async () => {
            await provider.connection()(tableName).insert([
                {name: 'Alice', email: 'alice@example.com', age: 25, active: true},
                {name: 'Bob', email: 'bob@example.com', age: 30, active: true},
                {name: 'Charlie', email: 'charlie@example.com', age: 35, active: false},
            ]);
        });

        test('clone() creates independent copy', async () => {
            const baseQuery = provider.connection().select('*').from(tableName).where('active', true);

            const clonedQuery = baseQuery.clone().where('age', '>', 25);

            // Original query should return both active users
            const originalResult = await baseQuery;
            expect(originalResult).toHaveLength(2);
            expect(originalResult.map((r: any) => r.name).sort()).toEqual(['Alice', 'Bob']);

            // Cloned query should only return Bob (active AND age > 25)
            const clonedResult = await clonedQuery;
            expect(clonedResult).toHaveLength(1);
            expect(clonedResult[0].name).toBe('Bob');
        });

        test('modifying original after clone does not affect clone', async () => {
            const baseQuery = provider.connection().select('*').from(tableName);

            const clonedQuery = baseQuery.clone().where('active', true);

            // Modify original after cloning
            baseQuery.where('active', false);

            // Clone should still have only active=true condition
            const clonedResult = await clonedQuery;
            expect(clonedResult).toHaveLength(2);
            expect(clonedResult.map((r: any) => r.name).sort()).toEqual(['Alice', 'Bob']);

            // Original should have active=false condition
            const originalResult = await baseQuery;
            expect(originalResult).toHaveLength(1);
            expect(originalResult[0].name).toBe('Charlie');
        });

        test('multiple clones are independent', async () => {
            const baseQuery = provider.connection().select('name').from(tableName);

            const clone1 = baseQuery.clone().where('age', 25);
            const clone2 = baseQuery.clone().where('age', 30);
            const clone3 = baseQuery.clone().where('age', 35);

            const [result1, result2, result3] = await Promise.all([clone1, clone2, clone3]);

            expect(result1).toHaveLength(1);
            expect(result1[0].name).toBe('Alice');

            expect(result2).toHaveLength(1);
            expect(result2[0].name).toBe('Bob');

            expect(result3).toHaveLength(1);
            expect(result3[0].name).toBe('Charlie');
        });

        test('clone toSQL() is independent', () => {
            const baseQuery = provider.connection().select('*').from(tableName).where('id', 1);

            const clonedQuery = baseQuery.clone().where('active', true);

            const originalSql = baseQuery.toSQL();
            const clonedSql = clonedQuery.toSQL();

            expect(originalSql.bindings).toEqual([1]);
            expect(clonedSql.bindings).toEqual([1, true]);
        });
    });

    describe('raw expressions in queries', () => {
        beforeEach(async () => {
            // Create a table with JSON data for testing raw expressions
            await pool.query(`
                DROP TABLE IF EXISTS async_knex_frameworks;
                CREATE TABLE async_knex_frameworks (
                    id SERIAL PRIMARY KEY,
                    organization_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    framework JSONB NOT NULL
                );
            `);

            await provider.connection()('async_knex_frameworks').insert([
                {
                    organization_id: 'org-1',
                    version: 1,
                    framework: JSON.stringify({name: 'React', createdAtMs: 1609459200000}),
                },
                {
                    organization_id: 'org-1',
                    version: 2,
                    framework: JSON.stringify({name: 'Vue', createdAtMs: 1612137600000}),
                },
                {
                    organization_id: 'org-2',
                    version: 1,
                    framework: JSON.stringify({name: 'Angular', createdAtMs: 1614556800000}),
                },
            ]);
        });

        afterEach(async () => {
            await pool.query('DROP TABLE IF EXISTS async_knex_frameworks');
        });

        test('connection.raw() inside select for JSON extraction', async () => {
            const connection = provider.connection();
            const result = await connection
                .table('async_knex_frameworks')
                .where('organization_id', 'org-1')
                .select([
                    'version',
                    connection.raw("framework->>'name' as name"),
                    connection.raw("(framework->>'createdAtMs')::bigint as created_at"),
                ])
                .orderBy('version', 'desc');

            expect(result).toHaveLength(2);
            expect(result[0]).toMatchObject({
                version: 2,
                name: 'Vue',
                created_at: '1612137600000',
            });
            expect(result[1]).toMatchObject({
                version: 1,
                name: 'React',
                created_at: '1609459200000',
            });
        });

        test('connection.raw() with bindings inside select', async () => {
            const connection = provider.connection();
            const result = await connection
                .table('async_knex_frameworks')
                .select([
                    'version',
                    connection.raw("CASE WHEN version > ? THEN 'new' ELSE 'old' END as status", [1]),
                ])
                .orderBy('version');

            expect(result).toHaveLength(3);
            // version 1 appears twice (org-1 and org-2), version 2 once
            expect(result[0].status).toBe('old'); // version 1
            expect(result[1].status).toBe('old'); // version 1
            expect(result[2].status).toBe('new'); // version 2
        });

        test('connection.raw() in where clause', async () => {
            const connection = provider.connection();
            const result = await connection
                .table('async_knex_frameworks')
                .select('version')
                .whereRaw("framework->>'name' = ?", ['React']);

            expect(result).toHaveLength(1);
            expect(result[0].version).toBe(1);
        });

        test('connection.raw() in orderBy', async () => {
            const connection = provider.connection();
            const result = await connection
                .table('async_knex_frameworks')
                .select('version', connection.raw("framework->>'name' as name"))
                .orderByRaw("framework->>'name' ASC");

            expect(result).toHaveLength(3);
            expect(result[0].name).toBe('Angular');
            expect(result[1].name).toBe('React');
            expect(result[2].name).toBe('Vue');
        });
    });

    // -- The property the package exists for: queries run on the connection the
    // -- ambient async context has claimed, never on one Knex opened itself.

    describe('ambient connection', () => {
        test('a query runs on the connection the ambient context has claimed', async () => {
            const claimed = await asyncPool.primary();
            const claimedPid = (await claimed.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

            const viaKnex = await provider.connection().raw('SELECT pg_backend_pid() AS pid');

            expect(viaKnex.rows[0].pid).toBe(claimedPid);
        });

        test('a write inside a transaction is visible on the transaction connection before the commit', async () => {
            const trx = await provider.begin();

            await trx(tableName).insert({name: 'Ambient', email: 'ambient@example.com'});

            const onTheTransactionConnection = await extractPgConnection(trx).query(
                `SELECT name FROM ${tableName}`,
            );
            expect(onTheTransactionConnection.rows).toEqual([{name: 'Ambient'}]);

            const onAnotherConnection = await pool.query(`SELECT name FROM ${tableName}`);
            expect(onAnotherConnection.rows).toEqual([]);

            await provider.commit(trx);

            expect((await pool.query(`SELECT name FROM ${tableName}`)).rows).toEqual([{name: 'Ambient'}]);
        });

        test('lazy queries inside a transaction run on the transaction connection', async () => {
            await provider.runInTransaction(async () => {
                const transactionConnection = extractPgConnection(provider.withTransaction());
                const transactionPid = (await transactionConnection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

                const lazyPid = (await provider.connection().raw('SELECT pg_backend_pid() AS pid')).rows[0].pid;

                expect(lazyPid).toBe(transactionPid);
            });
        });

        test('a query built before a transaction joins it when it is awaited inside', async () => {
            const insert = provider.connection()(tableName).insert({name: 'Late', email: 'late@example.com'});

            await expect(
                provider.runInTransaction(async () => {
                    await insert;

                    // Still invisible elsewhere, so the insert really joined the transaction.
                    expect((await pool.query(`SELECT name FROM ${tableName}`)).rows).toEqual([]);

                    throw new Error('changed my mind');
                }),
            ).rejects.toThrow('changed my mind');

            expect(await provider.connection().select('*').from(tableName)).toEqual([]);
        });
    });

    describe('knex pooling', () => {
        test('the knex instance has no pool of its own', () => {
            const client: Knex.Client = provider.connection().client;

            expect(client.pool).toBeUndefined();
        });

        test('knex cannot open a connection behind the adapter', async () => {
            const client: Knex.Client = provider.connection().client;

            await expect(client.acquireConnection()).rejects.toThrow('Unable to acquire a connection');
        });

        test('a knex pool configuration supplied by the consumer is ignored', () => {
            const configured = new AsyncKnexConnectionProvider(asyncPool, {knexConfig: {pool: {min: 2, max: 10}}});
            const client: Knex.Client = configured.connection().client;

            expect(client.pool).toBeUndefined();
        });
    });

    describe('knex configuration', () => {
        test('postProcessResponse and wrapIdentifier apply to routed queries', async () => {
            const configured = new AsyncKnexConnectionProvider(asyncPool, {
                knexConfig: {
                    postProcessResponse: result =>
                        Array.isArray(result) ? result.map(row => ({...row, source: 'configured'})) : result,
                    wrapIdentifier: (value, originalImplementation) =>
                        originalImplementation(value === 'displayName' ? 'name' : value),
                },
            });

            await configured.connection()(tableName).insert({name: 'Configured', email: 'configured@example.com'});

            const rows = await configured.connection()(tableName).select('displayName');

            expect(rows).toEqual([{name: 'Configured', source: 'configured'}]);
        });
    });

    describe('transaction lifecycle', () => {
        test('committing something that is not a transaction is refused', async () => {
            await expect(provider.commit(provider.connection() as unknown as Transaction)).rejects.toThrow(
                'Invalid transaction object - missing pg connection',
            );
        });

        test('a synchronous throw from the callback rolls the transaction back', async () => {
            const neverStarts = (): Promise<void> => {
                throw new Error('never even started');
            };

            await expect(provider.runInTransaction(neverStarts)).rejects.toThrow('never even started');

            expect(provider.inTransaction()).toBe(false);
            expect(await provider.connection().select('*').from(tableName)).toEqual([]);
        });

        describe('a commit the server rejects', () => {
            const deferredTable = 'async_knex_deferred';

            beforeAll(async () => {
                await pool.query(`
                    DROP TABLE IF EXISTS ${deferredTable};
                    CREATE TABLE ${deferredTable} (
                        id SERIAL PRIMARY KEY,
                        code TEXT NOT NULL,
                        CONSTRAINT ${deferredTable}_code_unique UNIQUE (code) DEFERRABLE INITIALLY DEFERRED
                    );
                `);
            });

            afterAll(async () => {
                await pool.query(`DROP TABLE IF EXISTS ${deferredTable}`);
            });

            beforeEach(async () => {
                await pool.query(`TRUNCATE ${deferredTable} RESTART IDENTITY`);
            });

            it('surfaces the constraint violation that made the commit fail', async () => {
                const error = await rejectionOf(
                    provider.runInTransaction(async () => {
                        await provider.connection()(deferredTable).insert([{code: 'same'}, {code: 'same'}]);
                    }),
                );

                expect(error.message).toContain('duplicate key value violates unique constraint');
            });
        });

        it('propagates the callback error when the rollback itself fails', async () => {
            const brittleRelease: AsyncPgPoolOptions = {
                releaseHookOnError: true,
                onRelease: () => {
                    throw new Error('resetting the session failed');
                },
            };

            await withDedicatedStack({connections: 1, options: brittleRelease}, async ({provider: brittle}) => {
                const error = await rejectionOf(
                    brittle.runInTransaction(async () => {
                        throw new Error('domain rule violated');
                    }),
                );

                expect(error.message).toContain('domain rule violated');
            });
        });
    });

    describe('nested transactions', () => {
        test('a nested runInTransaction commits once, at the outermost boundary', async () => {
            await provider.runInTransaction(async () => {
                await provider.connection()(tableName).insert({name: 'Outer', email: 'outer@example.com'});

                await provider.runInTransaction(async () => {
                    await provider.connection()(tableName).insert({name: 'Inner', email: 'inner@example.com'});
                });

                expect((await pool.query(`SELECT name FROM ${tableName}`)).rows).toEqual([]);
                expect(provider.inTransaction()).toBe(true);
            });

            const rows = await pool.query(`SELECT name FROM ${tableName} ORDER BY name`);
            expect(rows.rows).toEqual([{name: 'Inner'}, {name: 'Outer'}]);
        });

        test('a failure inside a nested runInTransaction rolls the outer transaction back', async () => {
            await expect(
                provider.runInTransaction(async () => {
                    await provider.connection()(tableName).insert({name: 'Outer', email: 'outer@example.com'});

                    await provider.runInTransaction(async () => {
                        await provider.connection()(tableName).insert({name: 'Inner', email: 'inner@example.com'});

                        throw new Error('inner step failed');
                    });
                }),
            ).rejects.toThrow('inner step failed');

            expect((await pool.query(`SELECT name FROM ${tableName}`)).rows).toEqual([]);
        });

        test('a nested failure the caller swallows keeps the inner writes, there are no savepoints', async () => {
            await provider.runInTransaction(async () => {
                await provider.connection()(tableName).insert({name: 'Outer', email: 'outer@example.com'});

                await rejectionOf(
                    provider.runInTransaction(async () => {
                        await provider.connection()(tableName).insert({name: 'Inner', email: 'inner@example.com'});

                        throw new Error('inner step failed');
                    }),
                );
            });

            const rows = await pool.query(`SELECT name FROM ${tableName} ORDER BY name`);
            expect(rows.rows).toEqual([{name: 'Inner'}, {name: 'Outer'}]);
        });

    });

    describe('connection release', () => {
        const singleConnection = {connections: 1, options: {keepPrimaryConnection: false} as AsyncPgPoolOptions};

        test('a constraint violation returns the connection to the pool', async () => {
            await withDedicatedStack(singleConnection, async ({provider: tiny}) => {
                await tiny.connection()(tableName).insert({name: 'First', email: 'clash@example.com'});

                for (let attempt = 0; attempt < 3; attempt++) {
                    await expect(
                        tiny.connection()(tableName).insert({name: 'Clash', email: 'clash@example.com'}),
                    ).rejects.toThrow(/duplicate key value/);
                }

                expect(await tiny.connection()(tableName).count('* as total')).toEqual([{total: '1'}]);
            });
        });

        test('a query for an unknown function returns the connection to the pool', async () => {
            await withDedicatedStack(singleConnection, async ({provider: tiny}) => {
                for (let attempt = 0; attempt < 3; attempt++) {
                    await expect(tiny.connection().raw('SELECT no_such_function()')).rejects.toThrow(/does not exist/);
                }

                await expect(tiny.connection().select('*').from(tableName)).resolves.toEqual([]);
            });
        });

        test('a value of the wrong type returns the connection to the pool', async () => {
            await withDedicatedStack(singleConnection, async ({provider: tiny}) => {
                for (let attempt = 0; attempt < 3; attempt++) {
                    await expect(
                        tiny.connection()(tableName).where('age', 'not-a-number').select('*'),
                    ).rejects.toThrow(/invalid input syntax for type integer/);
                }

                await expect(tiny.connection().select('*').from(tableName)).resolves.toEqual([]);
            });
        });

    });

    describe('identifier handling', () => {
        const hostileTable = `${tableName}"; DROP TABLE ${postsTable}; --`;

        const postsTableStillExists = async (): Promise<boolean> => {
            const result = await pool.query(`SELECT to_regclass('${postsTable}') IS NOT NULL AS present`);

            return result.rows[0].present;
        };

        test('a caller-supplied table name is escaped as an identifier', async () => {
            await expect(provider.connection()(hostileTable).select('*')).rejects.toThrow(/does not exist/);

            expect(await postsTableStillExists()).toBe(true);
        });

        test('the transaction wrapper escapes table names the same way', async () => {
            const trx = await provider.begin();

            await expect(trx(hostileTable).select('*')).rejects.toThrow(/does not exist/);

            await provider.rollback(trx);
            expect(await postsTableStillExists()).toBe(true);
        });

        test('a caller-supplied column name is escaped in the compiled SQL', () => {
            const sql = provider.connection()(tableName).select('name"; DROP TABLE x; --').toString();

            expect(sql).toBe(`select "name""; DROP TABLE x; --" from "${tableName}"`);
        });

        test('a value is bound as a parameter instead of being interpolated', () => {
            const compiled = provider.connection()(tableName).where('name', "'; DROP TABLE x; --").toSQL();

            expect(compiled.sql).toBe(`select * from "${tableName}" where "name" = ?`);
            expect(compiled.bindings).toEqual(["'; DROP TABLE x; --"]);
        });

        test('fn helpers are usable as query values', async () => {
            const connection = provider.connection();

            const rows = await connection(tableName)
                .insert({name: 'Timed', email: 'timed@example.com', created_at: connection.fn.now()})
                .returning('name');

            expect(rows).toEqual([{name: 'Timed'}]);
        });

        test('a failing query keeps parameter values out of the error message', async () => {
            await provider.connection()(tableName).insert({name: 'Existing', email: 'private-address@example.com'});

            const error = await rejectionOf(
                provider.connection()(tableName).insert({name: 'Duplicate', email: 'private-address@example.com'}),
            );

            expect(error.message).toContain('insert into');
            expect(error.message).not.toContain('private-address@example.com');
        });
    });

    describe('schema builder', () => {
        const schemaTable = 'async_knex_schema_builder';

        afterEach(async () => {
            await pool.query(`DROP TABLE IF EXISTS ${schemaTable}`);
        });

        const tableExists = async (): Promise<boolean> => {
            const result = await pool.query(`SELECT to_regclass('${schemaTable}') IS NOT NULL AS present`);

            return result.rows[0].present;
        };

        test('runs schema statements on the ambient connection', async () => {
            await provider.connection().schema.createTable(schemaTable, table => {
                table.increments('id');
            });

            expect(await tableExists()).toBe(true);
        });

        test('schema statements inside runInTransaction roll back with the transaction', async () => {
            await expect(provider.runInTransaction(async () => {
                await provider.connection().schema.createTable(schemaTable, table => {
                    table.increments('id');
                });

                throw new Error('the migration failed');
            })).rejects.toThrow('the migration failed');

            expect(await tableExists()).toBe(false);
        });

        test('schema statements on a transaction run inside it', async () => {
            const trx = await provider.begin();
            await trx.schema.createTable(schemaTable, table => {
                table.increments('id');
            });

            expect(await trx.schema.hasTable(schemaTable)).toBe(true);
            expect(await tableExists()).toBe(false);

            await provider.rollback(trx);

            expect(await tableExists()).toBe(false);
        });
    });

    describe('promise interface of a lazy query', () => {
        test('catch() reports the query failure', async () => {
            const caught = await provider
                .connection()
                .select('*')
                .from('async_knex_absent_table')
                .catch((error: Error) => error);

            expect(caught).toBeInstanceOf(Error);
        });

        test('finally() runs after the query completed', async () => {
            let completed = false;

            const rows = await provider
                .connection()
                .select('*')
                .from(tableName)
                .finally(() => {
                    completed = true;
                });

            expect(rows).toEqual([]);
            expect(completed).toBe(true);
        });

        test('a raw query supports catch() and finally()', async () => {
            let completed = false;

            const caught = await provider
                .connection()
                .raw('SELECT no_such_function()')
                .catch((error: Error) => error)
                .finally(() => {
                    completed = true;
                });

            expect(caught).toBeInstanceOf(Error);
            expect(completed).toBe(true);
        });
    });

    describe('shutdown', () => {
        test('destroy() can be called more than once', async () => {
            const disposable = new AsyncKnexConnectionProvider(asyncPool);

            await disposable.destroy();

            await expect(disposable.destroy()).resolves.toBeUndefined();
        });

        test('destroy() leaves the pool untouched, AsyncPgPool owns the connections', async () => {
            const disposable = new AsyncKnexConnectionProvider(asyncPool);

            await disposable.destroy();

            await expect(disposable.connection().select('*').from(tableName)).resolves.toEqual([]);
        });
    });

});
