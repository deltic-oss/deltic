import {Pool} from 'pg';
import {AsyncPgPool, asyncPoolContext, type AsyncPoolContext} from '@deltic/async-pg-pool';
import {AsyncDrizzleConnectionProvider, DrizzleTransactionsNotSupported} from './index.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {pgTestCredentials} from '../../pg-credentials.js';
import {pgTable, serial, text, integer, boolean, timestamp} from 'drizzle-orm/pg-core';
import {eq, sql} from 'drizzle-orm';

// -- Schema definitions for test tables --

const usersTable = pgTable('async_drizzle_test', {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').unique(),
    age: integer('age'),
    active: boolean('active').default(true),
    createdAt: timestamp('created_at').defaultNow(),
});

const postsTable = pgTable('async_drizzle_posts', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => usersTable.id),
    title: text('title').notNull(),
    content: text('content'),
    published: boolean('published').default(false),
    createdAt: timestamp('created_at').defaultNow(),
});

// -- Test setup --

const asyncLocalStorage = new AsyncLocalStorage<AsyncPoolContext>();
const setupContext = (): void => {
    asyncLocalStorage.enterWith(asyncPoolContext());
};

describe('AsyncDrizzleConnectionProvider', () => {
    let pool: Pool;
    let asyncPool: AsyncPgPool;
    let provider: AsyncDrizzleConnectionProvider;

    beforeAll(async () => {
        pool = new Pool(pgTestCredentials);
        asyncPool = new AsyncPgPool(pool, {keepConnections: 0});
        provider = new AsyncDrizzleConnectionProvider(asyncPool);

        // Create test tables
        await pool.query(`
            DROP TABLE IF EXISTS async_drizzle_posts;
            DROP TABLE IF EXISTS async_drizzle_test;
            CREATE TABLE async_drizzle_test (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE,
                age INTEGER,
                active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE async_drizzle_posts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES async_drizzle_test(id),
                title TEXT NOT NULL,
                content TEXT,
                published BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
    });

    afterAll(async () => {
        await pool.query('DROP TABLE IF EXISTS async_drizzle_posts');
        await pool.query('DROP TABLE IF EXISTS async_drizzle_test');
        await pool.end();
    });

    beforeEach(async () => {
        setupContext();
        await pool.query('TRUNCATE async_drizzle_posts, async_drizzle_test RESTART IDENTITY CASCADE');
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
            const result = await provider.connection().select().from(usersTable);

            expect(result).toEqual([]);
        });

        test('insert and select a single row', async () => {
            await provider.connection().insert(usersTable).values({name: 'Frank', email: 'frank@example.com', age: 35});

            const result = await provider.connection().select().from(usersTable);

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Frank');
            expect(result[0].email).toBe('frank@example.com');
            expect(result[0].age).toBe(35);
        });

        test('insert with returning', async () => {
            const result = await provider.connection()
                .insert(usersTable)
                .values({name: 'Alice', email: 'alice@example.com'})
                .returning();

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Alice');
            expect(result[0].id).toBe(1);
        });

        test('update rows', async () => {
            await provider.connection().insert(usersTable).values({name: 'Bob', age: 25});

            const result = await provider.connection()
                .update(usersTable)
                .set({age: 26})
                .where(eq(usersTable.name, 'Bob'))
                .returning();

            expect(result).toHaveLength(1);
            expect(result[0].age).toBe(26);
        });

        test('delete rows', async () => {
            await provider.connection().insert(usersTable).values({name: 'Charlie'});
            await provider.connection().insert(usersTable).values({name: 'Dave'});

            const deleted = await provider.connection()
                .delete(usersTable)
                .where(eq(usersTable.name, 'Charlie'))
                .returning();

            expect(deleted).toHaveLength(1);

            const remaining = await provider.connection().select().from(usersTable);
            expect(remaining).toHaveLength(1);
            expect(remaining[0].name).toBe('Dave');
        });
    });

    // -- Query building --

    describe('query building', () => {
        test('where clause', async () => {
            await provider.connection().insert(usersTable).values([
                {name: 'Alice', age: 30},
                {name: 'Bob', age: 25},
                {name: 'Charlie', age: 35},
            ]);

            const result = await provider.connection()
                .select()
                .from(usersTable)
                .where(eq(usersTable.name, 'Bob'));

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Bob');
        });

        test('select specific columns', async () => {
            await provider.connection().insert(usersTable).values({name: 'Alice', email: 'alice@example.com', age: 30});

            const result = await provider.connection()
                .select({name: usersTable.name, age: usersTable.age})
                .from(usersTable);

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({name: 'Alice', age: 30});
            expect((result[0] as any).email).toBeUndefined();
        });

        test('order by and limit', async () => {
            await provider.connection().insert(usersTable).values([
                {name: 'Charlie', age: 35},
                {name: 'Alice', age: 30},
                {name: 'Bob', age: 25},
            ]);

            const result = await provider.connection()
                .select()
                .from(usersTable)
                .orderBy(usersTable.age)
                .limit(2);

            expect(result).toHaveLength(2);
            expect(result[0].name).toBe('Bob');
            expect(result[1].name).toBe('Alice');
        });

        test('count', async () => {
            await provider.connection().insert(usersTable).values([
                {name: 'Alice'},
                {name: 'Bob'},
                {name: 'Charlie'},
            ]);

            const result = await provider.connection()
                .select({count: sql<number>`count(*)`})
                .from(usersTable);

            expect(Number(result[0].count)).toBe(3);
        });
    });

    // -- Raw queries --

    describe('raw queries', () => {
        test('execute raw SQL', async () => {
            await provider.connection().insert(usersTable).values({name: 'Frank', age: 35});

            const result = await provider.connection().execute(
                sql`SELECT name, age FROM async_drizzle_test WHERE age = ${35}`,
            );

            expect(result.rows).toHaveLength(1);
            expect(result.rows[0].name).toBe('Frank');
        });
    });

    // -- Transactions via AsyncPgPool (lazy connection route) --

    describe('transactions via AsyncPgPool', () => {
        test('committed transaction persists data', async () => {
            await asyncPool.runInTransaction(async () => {
                await provider.connection().insert(usersTable).values({name: 'Frank'});
                await provider.connection().insert(usersTable).values({name: 'Alice'});
            });

            const result = await provider.connection().select().from(usersTable);
            expect(result).toHaveLength(2);
        });

        test('rolled back transaction discards data', async () => {
            try {
                await asyncPool.runInTransaction(async () => {
                    await provider.connection().insert(usersTable).values({name: 'Frank'});
                    throw new Error('deliberate rollback');
                });
            } catch {
                // Expected
            }

            const result = await provider.connection().select().from(usersTable);
            expect(result).toHaveLength(0);
        });

        test('runInTransaction returns the function return value', async () => {
            const result = await asyncPool.runInTransaction(async () => {
                const [user] = await provider.connection()
                    .insert(usersTable)
                    .values({name: 'Frank'})
                    .returning();

                return user;
            });

            expect(result.name).toBe('Frank');
            expect(result.id).toBe(1);
        });
    });

    // -- Transactions via provider --

    describe('transactions via provider', () => {
        test('begin and commit persists data', async () => {
            const trx = await provider.begin();

            expect(provider.inTransaction()).toBe(true);

            await trx.insert(usersTable).values({name: 'Frank'});

            await provider.commit(trx);

            expect(provider.inTransaction()).toBe(false);

            const result = await provider.connection().select().from(usersTable);
            expect(result).toHaveLength(1);
        });

        test('begin and rollback discards data', async () => {
            const trx = await provider.begin();

            await trx.insert(usersTable).values({name: 'Frank'});

            await provider.rollback(trx);

            const result = await provider.connection().select().from(usersTable);
            expect(result).toHaveLength(0);
        });

        test('multiple operations in a single transaction', async () => {
            const trx = await provider.begin();

            const [user] = await trx
                .insert(usersTable)
                .values({name: 'Frank'})
                .returning();

            await trx.insert(postsTable).values({
                userId: user.id,
                title: 'First Post',
                content: 'Hello World',
            });

            await provider.commit(trx);

            const users = await provider.connection().select().from(usersTable);
            const posts = await provider.connection().select().from(postsTable);

            expect(users).toHaveLength(1);
            expect(posts).toHaveLength(1);
            expect(posts[0].userId).toBe(users[0].id);
        });

        test('transaction isolation — changes not visible outside until commit', async () => {
            const trx = await provider.begin();

            await trx.insert(usersTable).values({name: 'Frank'});

            // Query outside the transaction context using the raw pool
            const outsideResult = await pool.query('SELECT * FROM async_drizzle_test');
            expect(outsideResult.rows).toHaveLength(0);

            await provider.commit(trx);

            const afterCommit = await pool.query('SELECT * FROM async_drizzle_test');
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

        test('custom BEGIN query', async () => {
            const trx = await provider.begin('BEGIN ISOLATION LEVEL SERIALIZABLE');

            await trx.insert(usersTable).values({name: 'Frank'});
            await provider.commit(trx);

            const result = await provider.connection().select().from(usersTable);
            expect(result).toHaveLength(1);
        });

        test('queries on transaction instance use transaction connection', async () => {
            const trx = await provider.begin();

            await trx.insert(usersTable).values({name: 'Frank'});

            // Also verify the lazy connection() routes through the same transaction
            const viaLazy = await provider.connection().select().from(usersTable);
            expect(viaLazy).toHaveLength(1);

            await provider.commit(trx);
        });
    });

    // -- runInTransaction via provider --

    describe('runInTransaction via provider', () => {
        test('auto-commits on success', async () => {
            await provider.runInTransaction(async () => {
                await provider.connection().insert(usersTable).values({name: 'Frank'});
                await provider.connection().insert(usersTable).values({name: 'Alice'});
            });

            const result = await provider.connection().select().from(usersTable);
            expect(result).toHaveLength(2);
        });

        test('auto-rollbacks on error', async () => {
            try {
                await provider.runInTransaction(async () => {
                    await provider.connection().insert(usersTable).values({name: 'Frank'});
                    throw new Error('deliberate error');
                });
            } catch {
                // Expected
            }

            const result = await provider.connection().select().from(usersTable);
            expect(result).toHaveLength(0);
        });

        test('returns the function return value', async () => {
            const result = await provider.runInTransaction(async () => {
                const [user] = await provider.connection()
                    .insert(usersTable)
                    .values({name: 'Frank'})
                    .returning();

                return user;
            });

            expect(result.name).toBe('Frank');
            expect(result.id).toBe(1);
        });

        test('nested runInTransaction reuses existing transaction', async () => {
            await provider.runInTransaction(async () => {
                await provider.connection().insert(usersTable).values({name: 'Frank'});

                await provider.runInTransaction(async () => {
                    await provider.connection().insert(usersTable).values({name: 'Alice'});
                });
            });

            const result = await provider.connection().select().from(usersTable);
            expect(result).toHaveLength(2);
        });
    });

    // -- db.transaction() blocked --

    describe('drizzle transaction blocking', () => {
        test('connection().transaction() throws DrizzleTransactionsNotSupported', () => {
            expect(() => {
                provider.connection().transaction(async () => {
                    // Should never reach here
                });
            }).toThrow(DrizzleTransactionsNotSupported);
        });

        test('begin() result transaction() also throws', async () => {
            const trx = await provider.begin();

            expect(() => {
                trx.transaction(async () => {});
            }).toThrow(DrizzleTransactionsNotSupported);

            await provider.rollback(trx);
        });

        test('error has correct code', () => {
            try {
                provider.connection().transaction(async () => {});
                expect.fail('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(DrizzleTransactionsNotSupported);
                expect((e as DrizzleTransactionsNotSupported).code).toBe(
                    'async-pg-drizzle.transactions_not_supported',
                );
            }
        });
    });

    // -- Connection lifecycle --

    describe('connection lifecycle', () => {
        test('sequential queries do not hang', async () => {
            for (let i = 0; i < 10; i++) {
                await provider.connection().select().from(usersTable);
            }
        });

        test('query error does not leak connections', async () => {
            await provider.connection().insert(usersTable).values({name: 'Frank', email: 'frank@example.com'});

            try {
                await provider.connection().insert(usersTable).values({name: 'Duplicate', email: 'frank@example.com'});
            } catch {
                // Expected unique violation
            }

            const result = await provider.connection().select().from(usersTable);
            expect(result).toHaveLength(1);
        });
    });

    // -- Joins --

    describe('joins', () => {
        test('inner join', async () => {
            const [user] = await provider.connection()
                .insert(usersTable)
                .values({name: 'Frank'})
                .returning();

            await provider.connection().insert(postsTable).values({
                userId: user.id,
                title: 'Test Post',
            });

            const result = await provider.connection()
                .select({
                    userName: usersTable.name,
                    postTitle: postsTable.title,
                })
                .from(usersTable)
                .innerJoin(postsTable, eq(usersTable.id, postsTable.userId));

            expect(result).toHaveLength(1);
            expect(result[0].userName).toBe('Frank');
            expect(result[0].postTitle).toBe('Test Post');
        });

        test('left join includes unmatched rows', async () => {
            await provider.connection().insert(usersTable).values([
                {name: 'Frank'},
                {name: 'Alice'},
            ]);

            const [frank] = await provider.connection()
                .select()
                .from(usersTable)
                .where(eq(usersTable.name, 'Frank'));

            await provider.connection().insert(postsTable).values({
                userId: frank.id,
                title: 'Frank Post',
            });

            const result = await provider.connection()
                .select({
                    userName: usersTable.name,
                    postTitle: postsTable.title,
                })
                .from(usersTable)
                .leftJoin(postsTable, eq(usersTable.id, postsTable.userId))
                .orderBy(usersTable.name);

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({userName: 'Alice', postTitle: null});
            expect(result[1]).toEqual({userName: 'Frank', postTitle: 'Frank Post'});
        });
    });

    // -- Schema-typed provider --

    describe('schema-typed provider', () => {
        test('provider with schema provides typed results', async () => {
            const schema = {usersTable, postsTable};
            const typedProvider = new AsyncDrizzleConnectionProvider(asyncPool, {schema});

            await typedProvider.connection().insert(usersTable).values({name: 'Frank', age: 35});

            const result = await typedProvider.connection().select().from(usersTable);

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Frank');
            expect(result[0].age).toBe(35);
        });
    });
});
