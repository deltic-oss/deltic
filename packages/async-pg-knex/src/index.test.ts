import {Pool} from 'pg';
import {AsyncPgPool, asyncPoolContext, type AsyncPoolContext} from '@deltic/async-pg-pool';
import {AsyncKnexConnectionProvider} from './index.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {pgTestCredentials} from '../../pg-credentials.js';

const asyncLocalStorage = new AsyncLocalStorage<AsyncPoolContext>();
const setupContext = () => asyncLocalStorage.enterWith(asyncPoolContext());

describe('AsyncKnexConnectionProvider', () => {
    let pool: Pool;
    let asyncPool: AsyncPgPool;
    let provider: AsyncKnexConnectionProvider;
    const tableName = 'async_knex_test';
    const postsTable = 'async_knex_posts';

    beforeAll(async () => {
        pool = new Pool(pgTestCredentials);
        asyncPool = new AsyncPgPool(pool, {keepConnections: 0});
        provider = new AsyncKnexConnectionProvider(asyncPool);

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
        await provider.destroy();
        await pool.end();
    });

    beforeEach(async () => {
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
        await asyncPool.flushSharedContext();
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

        test('withTransaction() returns current transaction', async () => {
            const trx = await provider.begin();

            const currentTrx = provider.withTransaction();
            expect(currentTrx).toBe(trx);

            await provider.commit(trx);
        });

        test('withTransaction() throws when not in transaction', () => {
            expect(() => provider.withTransaction()).toThrow('Not in a transaction');
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
});
