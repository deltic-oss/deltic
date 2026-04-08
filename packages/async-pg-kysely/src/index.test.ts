import {Pool} from 'pg';
import Cursor from 'pg-cursor';
import {AsyncPgPool, asyncPoolContext, type AsyncPoolContext} from '@deltic/async-pg-pool';
import {AsyncKyselyConnectionProvider, KyselyTransactionsNotSupported} from './index.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {pgTestCredentials} from '../../pg-credentials.js';
import {sql, type Generated} from 'kysely';

// -- Type definitions for test tables --

interface UsersTable {
    id: Generated<number>;
    name: string;
    email: string | null;
    age: number | null;
    active: Generated<boolean>;
    created_at: Generated<Date>;
}

interface PostsTable {
    id: Generated<number>;
    user_id: number | null;
    title: string;
    content: string | null;
    published: Generated<boolean>;
    created_at: Generated<Date>;
}

interface DB {
    async_kysely_test: UsersTable;
    async_kysely_posts: PostsTable;
}

// -- Test setup --

const asyncLocalStorage = new AsyncLocalStorage<AsyncPoolContext>();
const setupContext = (): void => {
    asyncLocalStorage.enterWith(asyncPoolContext());
};

describe('AsyncKyselyConnectionProvider', () => {
    let pool: Pool;
    let asyncPool: AsyncPgPool;
    let provider: AsyncKyselyConnectionProvider<DB>;

    beforeAll(async () => {
        pool = new Pool(pgTestCredentials);
        asyncPool = new AsyncPgPool(pool, {keepConnections: 0});
        provider = new AsyncKyselyConnectionProvider<DB>(asyncPool);

        await pool.query(`
            DROP TABLE IF EXISTS async_kysely_posts;
            DROP TABLE IF EXISTS async_kysely_test;
            CREATE TABLE async_kysely_test (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE,
                age INTEGER,
                active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE async_kysely_posts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES async_kysely_test(id),
                title TEXT NOT NULL,
                content TEXT,
                published BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
    });

    afterAll(async () => {
        await provider.destroy();
        await pool.query('DROP TABLE IF EXISTS async_kysely_posts');
        await pool.query('DROP TABLE IF EXISTS async_kysely_test');
        await pool.end();
    });

    beforeEach(async () => {
        setupContext();
        await pool.query('TRUNCATE async_kysely_posts, async_kysely_test RESTART IDENTITY CASCADE');
    });

    afterEach(async () => {
        if (asyncPool.inTransaction()) {
            try {
                await asyncPool.rollback(asyncPool.withTransaction());
            } catch {
                // Ignore errors during cleanup
            }
        }
        await asyncPool.flushSharedContext();
    });

    // -- Basic queries --

    describe('basic queries', () => {
        test('select on empty table returns empty array', async () => {
            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .execute();

            expect(result).toEqual([]);
        });

        test('insert and select a single row', async () => {
            await provider.connection()
                .insertInto('async_kysely_test')
                .values({name: 'Frank', email: 'frank@example.com', age: 35})
                .execute();

            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .execute();

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Frank');
            expect(result[0].email).toBe('frank@example.com');
            expect(result[0].age).toBe(35);
        });

        test('insert with returning', async () => {
            const result = await provider.connection()
                .insertInto('async_kysely_test')
                .values({name: 'Alice', email: 'alice@example.com'})
                .returningAll()
                .executeTakeFirstOrThrow();

            expect(result.name).toBe('Alice');
            expect(result.id).toBe(1);
        });

        test('update rows', async () => {
            await provider.connection()
                .insertInto('async_kysely_test')
                .values({name: 'Bob', age: 25})
                .execute();

            const result = await provider.connection()
                .updateTable('async_kysely_test')
                .set({age: 26})
                .where('name', '=', 'Bob')
                .returningAll()
                .executeTakeFirstOrThrow();

            expect(result.age).toBe(26);
        });

        test('delete rows', async () => {
            await provider.connection()
                .insertInto('async_kysely_test')
                .values({name: 'Charlie'})
                .execute();
            await provider.connection()
                .insertInto('async_kysely_test')
                .values({name: 'Dave'})
                .execute();

            const deleted = await provider.connection()
                .deleteFrom('async_kysely_test')
                .where('name', '=', 'Charlie')
                .returningAll()
                .execute();

            expect(deleted).toHaveLength(1);

            const remaining = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .execute();

            expect(remaining).toHaveLength(1);
            expect(remaining[0].name).toBe('Dave');
        });
    });

    // -- Query building --

    describe('query building', () => {
        test('where clause', async () => {
            await provider.connection()
                .insertInto('async_kysely_test')
                .values([
                    {name: 'Alice', age: 30},
                    {name: 'Bob', age: 25},
                    {name: 'Charlie', age: 35},
                ])
                .execute();

            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .where('name', '=', 'Bob')
                .execute();

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Bob');
        });

        test('select specific columns', async () => {
            await provider.connection()
                .insertInto('async_kysely_test')
                .values({name: 'Alice', email: 'alice@example.com', age: 30})
                .execute();

            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .select(['name', 'age'])
                .executeTakeFirstOrThrow();

            expect(result).toEqual({name: 'Alice', age: 30});
        });

        test('order by and limit', async () => {
            await provider.connection()
                .insertInto('async_kysely_test')
                .values([
                    {name: 'Charlie', age: 35},
                    {name: 'Alice', age: 30},
                    {name: 'Bob', age: 25},
                ])
                .execute();

            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .orderBy('age', 'asc')
                .limit(2)
                .execute();

            expect(result).toHaveLength(2);
            expect(result[0].name).toBe('Bob');
            expect(result[1].name).toBe('Alice');
        });

        test('count', async () => {
            await provider.connection()
                .insertInto('async_kysely_test')
                .values([
                    {name: 'Alice'},
                    {name: 'Bob'},
                    {name: 'Charlie'},
                ])
                .execute();

            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .select((eb) => [eb.fn.countAll().as('count')])
                .executeTakeFirstOrThrow();

            expect(Number(result.count)).toBe(3);
        });
    });

    // -- Raw queries --

    describe('raw queries', () => {
        test('execute raw SQL', async () => {
            await provider.connection()
                .insertInto('async_kysely_test')
                .values({name: 'Frank', age: 35})
                .execute();

            const result = await sql<{name: string; age: number}>`SELECT name, age FROM async_kysely_test WHERE age = ${35}`
                .execute(provider.connection());

            expect(result.rows).toHaveLength(1);
            expect(result.rows[0].name).toBe('Frank');
        });
    });

    // -- Transactions via AsyncPgPool --

    describe('transactions via AsyncPgPool', () => {
        test('committed transaction persists data', async () => {
            await asyncPool.runInTransaction(async () => {
                await provider.connection()
                    .insertInto('async_kysely_test')
                    .values({name: 'Frank'})
                    .execute();
                await provider.connection()
                    .insertInto('async_kysely_test')
                    .values({name: 'Alice'})
                    .execute();
            });

            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .execute();

            expect(result).toHaveLength(2);
        });

        test('rolled back transaction discards data', async () => {
            try {
                await asyncPool.runInTransaction(async () => {
                    await provider.connection()
                        .insertInto('async_kysely_test')
                        .values({name: 'Frank'})
                        .execute();
                    throw new Error('deliberate rollback');
                });
            } catch {
                // Expected
            }

            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .execute();

            expect(result).toHaveLength(0);
        });
    });

    // -- Transactions via provider --

    describe('transactions via provider', () => {
        test('begin and commit persists data', async () => {
            const trx = await provider.begin();

            expect(provider.inTransaction()).toBe(true);

            await trx.insertInto('async_kysely_test')
                .values({name: 'Frank'})
                .execute();

            await provider.commit(trx);

            expect(provider.inTransaction()).toBe(false);

            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .execute();

            expect(result).toHaveLength(1);
        });

        test('begin and rollback discards data', async () => {
            const trx = await provider.begin();

            await trx.insertInto('async_kysely_test')
                .values({name: 'Frank'})
                .execute();

            await provider.rollback(trx);

            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .execute();

            expect(result).toHaveLength(0);
        });

        test('multiple operations in a single transaction', async () => {
            const trx = await provider.begin();

            const user = await trx.insertInto('async_kysely_test')
                .values({name: 'Frank'})
                .returningAll()
                .executeTakeFirstOrThrow();

            await trx.insertInto('async_kysely_posts')
                .values({
                    user_id: user.id,
                    title: 'First Post',
                    content: 'Hello World',
                })
                .execute();

            await provider.commit(trx);

            const users = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .execute();
            const posts = await provider.connection()
                .selectFrom('async_kysely_posts')
                .selectAll()
                .execute();

            expect(users).toHaveLength(1);
            expect(posts).toHaveLength(1);
            expect(posts[0].user_id).toBe(users[0].id);
        });

        test('transaction isolation — changes not visible outside until commit', async () => {
            const trx = await provider.begin();

            await trx.insertInto('async_kysely_test')
                .values({name: 'Frank'})
                .execute();

            const outsideResult = await pool.query('SELECT * FROM async_kysely_test');
            expect(outsideResult.rows).toHaveLength(0);

            await provider.commit(trx);

            const afterCommit = await pool.query('SELECT * FROM async_kysely_test');
            expect(afterCommit.rows).toHaveLength(1);
        });

        test('withTransaction returns current transaction', async () => {
            const trx = await provider.begin();

            const currentTrx = provider.withTransaction();
            expect(currentTrx).toBe(trx);

            await provider.commit(trx);
        });

        test('withTransaction throws when not in transaction', () => {
            expect(() => provider.withTransaction()).toThrow('Not in a transaction. Call begin() first.');
        });

        test('queries on transaction instance use transaction connection', async () => {
            const trx = await provider.begin();

            await trx.insertInto('async_kysely_test')
                .values({name: 'Frank'})
                .execute();

            // Verify the lazy connection() also sees the data (same pool context)
            const viaLazy = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .execute();

            expect(viaLazy).toHaveLength(1);

            await provider.commit(trx);
        });
    });

    // -- runInTransaction via provider --

    describe('runInTransaction via provider', () => {
        test('auto-commits on success', async () => {
            await provider.runInTransaction(async () => {
                await provider.connection()
                    .insertInto('async_kysely_test')
                    .values({name: 'Frank'})
                    .execute();
                await provider.connection()
                    .insertInto('async_kysely_test')
                    .values({name: 'Alice'})
                    .execute();
            });

            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .execute();

            expect(result).toHaveLength(2);
        });

        test('auto-rollbacks on error', async () => {
            try {
                await provider.runInTransaction(async () => {
                    await provider.connection()
                        .insertInto('async_kysely_test')
                        .values({name: 'Frank'})
                        .execute();
                    throw new Error('deliberate error');
                });
            } catch {
                // Expected
            }

            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .execute();

            expect(result).toHaveLength(0);
        });

        test('returns the function return value', async () => {
            const user = await provider.runInTransaction(async () => {
                return await provider.connection()
                    .insertInto('async_kysely_test')
                    .values({name: 'Frank'})
                    .returningAll()
                    .executeTakeFirstOrThrow();
            });

            expect(user.name).toBe('Frank');
            expect(user.id).toBe(1);
        });

        test('nested runInTransaction reuses existing transaction', async () => {
            await provider.runInTransaction(async () => {
                await provider.connection()
                    .insertInto('async_kysely_test')
                    .values({name: 'Frank'})
                    .execute();

                await provider.runInTransaction(async () => {
                    await provider.connection()
                        .insertInto('async_kysely_test')
                        .values({name: 'Alice'})
                        .execute();
                });
            });

            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .execute();

            expect(result).toHaveLength(2);
        });
    });

    // -- transaction() blocked --

    describe('kysely transaction blocking', () => {
        test('connection().transaction() throws KyselyTransactionsNotSupported', () => {
            expect(() => {
                provider.connection().transaction();
            }).toThrow(KyselyTransactionsNotSupported);
        });

        test('connection().startTransaction() throws KyselyTransactionsNotSupported', () => {
            expect(() => {
                provider.connection().startTransaction();
            }).toThrow(KyselyTransactionsNotSupported);
        });

        test('begin() result transaction() also throws', async () => {
            const trx = await provider.begin();

            expect(() => {
                trx.transaction();
            }).toThrow(KyselyTransactionsNotSupported);

            await provider.rollback(trx);
        });

        test('begin() result startTransaction() also throws', async () => {
            const trx = await provider.begin();

            expect(() => {
                trx.startTransaction();
            }).toThrow(KyselyTransactionsNotSupported);

            await provider.rollback(trx);
        });

        test('error has correct code', () => {
            try {
                provider.connection().transaction();
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(KyselyTransactionsNotSupported);
                expect((e as KyselyTransactionsNotSupported).code).toBe(
                    'async-pg-kysely.transactions_not_supported',
                );
            }
        });
    });

    // -- Connection lifecycle --

    describe('connection lifecycle', () => {
        test('sequential queries do not hang', async () => {
            for (let i = 0; i < 10; i++) {
                await provider.connection()
                    .selectFrom('async_kysely_test')
                    .selectAll()
                    .execute();
            }
        });

        test('query error does not leak connections', async () => {
            await provider.connection()
                .insertInto('async_kysely_test')
                .values({name: 'Frank', email: 'frank@example.com'})
                .execute();

            try {
                await provider.connection()
                    .insertInto('async_kysely_test')
                    .values({name: 'Duplicate', email: 'frank@example.com'})
                    .execute();
            } catch {
                // Expected unique violation
            }

            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .execute();

            expect(result).toHaveLength(1);
        });
    });

    // -- Joins --

    describe('joins', () => {
        test('inner join', async () => {
            const user = await provider.connection()
                .insertInto('async_kysely_test')
                .values({name: 'Frank'})
                .returningAll()
                .executeTakeFirstOrThrow();

            await provider.connection()
                .insertInto('async_kysely_posts')
                .values({user_id: user.id, title: 'Test Post'})
                .execute();

            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .innerJoin('async_kysely_posts', 'async_kysely_posts.user_id', 'async_kysely_test.id')
                .select([
                    'async_kysely_test.name as user_name',
                    'async_kysely_posts.title as post_title',
                ])
                .execute();

            expect(result).toHaveLength(1);
            expect(result[0].user_name).toBe('Frank');
            expect(result[0].post_title).toBe('Test Post');
        });

        test('left join includes unmatched rows', async () => {
            await provider.connection()
                .insertInto('async_kysely_test')
                .values([{name: 'Frank'}, {name: 'Alice'}])
                .execute();

            const frank = await provider.connection()
                .selectFrom('async_kysely_test')
                .selectAll()
                .where('name', '=', 'Frank')
                .executeTakeFirstOrThrow();

            await provider.connection()
                .insertInto('async_kysely_posts')
                .values({user_id: frank.id, title: 'Frank Post'})
                .execute();

            const result = await provider.connection()
                .selectFrom('async_kysely_test')
                .leftJoin('async_kysely_posts', 'async_kysely_posts.user_id', 'async_kysely_test.id')
                .select([
                    'async_kysely_test.name as user_name',
                    'async_kysely_posts.title as post_title',
                ])
                .orderBy('async_kysely_test.name', 'asc')
                .execute();

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({user_name: 'Alice', post_title: null});
            expect(result[1]).toEqual({user_name: 'Frank', post_title: 'Frank Post'});
        });
    });

    // -- numAffectedRows --

    describe('affected rows', () => {
        test('insert returns numAffectedRows', async () => {
            const result = await provider.connection()
                .insertInto('async_kysely_test')
                .values([{name: 'Alice'}, {name: 'Bob'}])
                .executeTakeFirstOrThrow();

            expect(result.numInsertedOrUpdatedRows).toBe(2n);
        });

        test('update returns numAffectedRows', async () => {
            await provider.connection()
                .insertInto('async_kysely_test')
                .values([{name: 'Alice', age: 30}, {name: 'Bob', age: 25}])
                .execute();

            const result = await provider.connection()
                .updateTable('async_kysely_test')
                .set({age: 99})
                .executeTakeFirstOrThrow();

            expect(result.numUpdatedRows).toBe(2n);
        });

        test('delete returns numAffectedRows', async () => {
            await provider.connection()
                .insertInto('async_kysely_test')
                .values([{name: 'Alice'}, {name: 'Bob'}])
                .execute();

            const result = await provider.connection()
                .deleteFrom('async_kysely_test')
                .where('name', '=', 'Alice')
                .executeTakeFirstOrThrow();

            expect(result.numDeletedRows).toBe(1n);
        });
    });

    // -- Streaming queries --

    describe('streaming queries', () => {
        test('streamQuery throws when cursor is not configured', async () => {
            await expect(async () => {
                for await (const _chunk of provider.connection()
                    .selectFrom('async_kysely_test')
                    .selectAll()
                    .stream(10)) {
                    // should not reach here
                }
            }).rejects.toThrow("'cursor' is not present");
        });

        describe('with cursor configured', () => {
            let streamProvider: AsyncKyselyConnectionProvider<DB>;

            beforeAll(() => {
                streamProvider = new AsyncKyselyConnectionProvider<DB>(asyncPool, {
                    cursor: Cursor,
                });
            });

            afterAll(async () => {
                await streamProvider.destroy();
            });

            test('streams all rows', async () => {
                await streamProvider.connection()
                    .insertInto('async_kysely_test')
                    .values([
                        {name: 'Alice'},
                        {name: 'Bob'},
                        {name: 'Charlie'},
                    ])
                    .execute();

                const names: string[] = [];

                for await (const row of streamProvider.connection()
                    .selectFrom('async_kysely_test')
                    .select(['name'])
                    .orderBy('name', 'asc')
                    .stream(10)) {
                    names.push(row.name);
                }

                expect(names).toEqual(['Alice', 'Bob', 'Charlie']);
            });

            test('streaming works inside a transaction', async () => {
                const trx = await streamProvider.begin();

                await trx.insertInto('async_kysely_test')
                    .values([{name: 'Frank'}, {name: 'Grace'}])
                    .execute();

                const names: string[] = [];
                for await (const row of trx
                    .selectFrom('async_kysely_test')
                    .select(['name'])
                    .orderBy('name', 'asc')
                    .stream(10)) {
                    names.push(row.name);
                }

                expect(names).toEqual(['Frank', 'Grace']);

                await streamProvider.rollback(trx);
            });

            test('chunkSize of zero throws', async () => {
                await expect(async () => {
                    for await (const _chunk of streamProvider.connection()
                        .selectFrom('async_kysely_test')
                        .selectAll()
                        .stream(0)) {
                        // noop
                    }
                }).rejects.toThrow('chunkSize must be a positive integer');
            });

            test('non-integer chunkSize throws', async () => {
                await expect(async () => {
                    for await (const _chunk of streamProvider.connection()
                        .selectFrom('async_kysely_test')
                        .selectAll()
                        .stream(1.5)) {
                        // noop
                    }
                }).rejects.toThrow('chunkSize must be a positive integer');
            });
        });
    });
});
