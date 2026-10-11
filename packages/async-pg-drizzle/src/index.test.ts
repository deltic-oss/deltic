import {Pool} from 'pg';
import {
    AsyncPgPool,
    asyncPoolContext,
    type AsyncPgPoolOptions,
    type AsyncPoolContext,
} from '@deltic/async-pg-pool';
import {
    AsyncDrizzleConnectionProvider,
    DrizzleTransactionsNotSupported,
    extractPgConnection,
    pgConnectionSymbol,
} from './index.js';
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

/**
 * Same table as usersTable, but with implicit column names so the `casing`
 * option decides how the property names are translated to columns.
 */
const implicitNamesTable = pgTable('async_drizzle_test', {
    id: serial(),
    name: text(),
    createdAt: timestamp(),
});

// -- Test setup --

const asyncLocalStorage = new AsyncLocalStorage<AsyncPoolContext>();
const setupContext = (): void => {
    asyncLocalStorage.enterWith(asyncPoolContext());
};

interface DedicatedStack {
    pgPool: Pool;
    asyncPool: AsyncPgPool;
    provider: AsyncDrizzleConnectionProvider;
}

/**
 * Builds a provider on top of a pool that is not shared with any other test,
 * so pool capacity and connection lifecycle can be reasoned about without
 * looking at global database state.
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
    const provider = new AsyncDrizzleConnectionProvider(asyncPool);

    try {
        return await use({pgPool, asyncPool, provider});
    } finally {
        // Best effort: a leaked transaction lock makes flush() — and with it the
        // shutdown of a pool that still has a connection checked out — block forever.
        await settlesWithin(asyncPool.flush(), 500);
        await settlesWithin(pgPool.end(), 1500);
    }
};

/**
 * Resolves to 'settled' or 'timed out' without ever leaving the promise
 * unhandled, so a deadlock surfaces as a failed assertion instead of a hang.
 */
const settlesWithin = async (promise: Promise<unknown>, milliseconds: number): Promise<'settled' | 'timed out'> => {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const expiry = new Promise<'timed out'>(resolve => {
        timer = setTimeout(() => resolve('timed out'), milliseconds);
    });

    try {
        return await Promise.race([
            promise.then(() => 'settled' as const, () => 'settled' as const),
            expiry,
        ]);
    } finally {
        clearTimeout(timer);
    }
};

const rejectionOf = async (promise: Promise<unknown>): Promise<Error> => {
    try {
        await promise;
    } catch (error) {
        return error as Error;
    }

    throw new Error('Expected the promise to reject, but it resolved');
};

/**
 * Drizzle wraps driver errors in a DrizzleQueryError, the driver error is the cause.
 */
const causeOf = (error: Error): Error & {code?: string} => error.cause as Error & {code?: string};

describe('AsyncDrizzleConnectionProvider', () => {
    let pool: Pool;
    let asyncPool: AsyncPgPool;
    let provider: AsyncDrizzleConnectionProvider;

    beforeAll(async () => {
        pool = new Pool(pgTestCredentials);

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
        asyncPool = new AsyncPgPool(pool, {keepConnections: 0});
        provider = new AsyncDrizzleConnectionProvider(asyncPool);

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
        await asyncPool.flush();
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

        test('withTransaction returns an instance bound to the active transaction', async () => {
            const trx = await provider.begin();

            const currentTrx = provider.withTransaction();
            expect((currentTrx as any)[pgConnectionSymbol]).toBe((trx as any)[pgConnectionSymbol]);

            await provider.commit(trx);
        });

        test('withTransaction throws when not in transaction', () => {
            expect(() => provider.withTransaction()).toThrow('no transaction was active');
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

    // -- The reason this package exists: queries run on the connection the ambient context claimed --

    describe('ambient connection routing', () => {
        test('a lazy write is visible to a raw query on the claimed transaction connection', async () => {
            await asyncPool.runInTransaction(async () => {
                await provider.connection().insert(usersTable).values({name: 'Frank'});

                const onTheClaimedConnection = await asyncPool.withTransaction()
                    .query('SELECT name FROM async_drizzle_test');
                expect(onTheClaimedConnection.rows).toEqual([{name: 'Frank'}]);

                const onAnotherConnection = await pool.query('SELECT name FROM async_drizzle_test');
                expect(onAnotherConnection.rows).toEqual([]);
            });

            const afterCommit = await pool.query('SELECT name FROM async_drizzle_test');
            expect(afterCommit.rows).toEqual([{name: 'Frank'}]);
        });

        test('lazy and transaction-bound writes end up in the same transaction', async () => {
            const trx = await provider.begin();

            await trx.insert(usersTable).values({name: 'bound'});
            await provider.connection().insert(usersTable).values({name: 'lazy'});

            const insideTheTransaction = await trx.select().from(usersTable).orderBy(usersTable.name);
            expect(insideTheTransaction.map(row => row.name)).toEqual(['bound', 'lazy']);

            await provider.rollback(trx);

            const afterRollback = await pool.query('SELECT name FROM async_drizzle_test');
            expect(afterRollback.rows).toEqual([]);
        });

        test('the transaction connection is retained across lazy queries', async () => {
            await expect(asyncPool.runInTransaction(async () => {
                const claimed = asyncPool.withTransaction();

                for (let index = 0; index < 5; index++) {
                    await provider.connection().insert(usersTable).values({name: `row-${index}`});
                }

                expect(asyncPool.withTransaction()).toBe(claimed);
                expect(provider.inTransaction()).toBe(true);

                throw new Error('discard everything');
            })).rejects.toThrow('discard everything');

            const rows = await pool.query('SELECT name FROM async_drizzle_test');
            expect(rows.rows).toEqual([]);
        });

        test('the relational query API resolves through the transaction connection', async () => {
            const typedProvider = new AsyncDrizzleConnectionProvider(asyncPool, {schema: {usersTable, postsTable}});

            await expect(asyncPool.runInTransaction(async () => {
                await typedProvider.connection().insert(usersTable).values({name: 'Frank'});

                const found = await typedProvider.connection().query.usersTable.findMany();
                expect(found.map(user => user.name)).toEqual(['Frank']);

                const onAnotherConnection = await pool.query('SELECT name FROM async_drizzle_test');
                expect(onAnotherConnection.rows).toEqual([]);

                throw new Error('discard everything');
            })).rejects.toThrow('discard everything');
        });

    });

    // -- Async context scoping --

    // -- Transaction failure semantics --

    describe('transaction failure semantics', () => {
        test('the error thrown inside runInTransaction propagates unchanged', async () => {
            const failure = new Error('domain failure');

            const caught = await rejectionOf(provider.runInTransaction(async () => {
                await provider.connection().insert(usersTable).values({name: 'Frank'});

                throw failure;
            }));

            expect(caught).toBe(failure);
            expect((await pool.query('SELECT name FROM async_drizzle_test')).rows).toEqual([]);
        });

        test('a constraint violation rolls the whole transaction back', async () => {
            const caught = await rejectionOf(provider.runInTransaction(async () => {
                await provider.connection().insert(usersTable).values({name: 'first', email: 'clash@example.com'});
                await provider.connection().insert(usersTable).values({name: 'second', email: 'clash@example.com'});
            }));

            expect(causeOf(caught).code).toBe('23505');
            expect((await pool.query('SELECT name FROM async_drizzle_test')).rows).toEqual([]);
        });

    });

    // -- Nesting --

    describe('nested transactions', () => {
        test('nested runInTransaction commits once, at the outermost boundary', async () => {
            await provider.runInTransaction(async () => {
                await provider.connection().insert(usersTable).values({name: 'outer'});

                await provider.runInTransaction(async () => {
                    await provider.connection().insert(usersTable).values({name: 'inner'});
                });

                expect((await pool.query('SELECT name FROM async_drizzle_test')).rows).toEqual([]);
                expect(provider.inTransaction()).toBe(true);
            });

            const rows = await pool.query('SELECT name FROM async_drizzle_test ORDER BY name');
            expect(rows.rows).toEqual([{name: 'inner'}, {name: 'outer'}]);
        });

        test('a failure inside a nested runInTransaction rolls the outer transaction back', async () => {
            await expect(provider.runInTransaction(async () => {
                await provider.connection().insert(usersTable).values({name: 'outer'});

                await provider.runInTransaction(async () => {
                    await provider.connection().insert(usersTable).values({name: 'inner'});

                    throw new Error('inner failure');
                });
            })).rejects.toThrow('inner failure');

            expect((await pool.query('SELECT name FROM async_drizzle_test')).rows).toEqual([]);
        });

        test('a nested failure that the caller swallows keeps the inner writes, there are no savepoints', async () => {
            await provider.runInTransaction(async () => {
                await provider.connection().insert(usersTable).values({name: 'outer'});

                await rejectionOf(provider.runInTransaction(async () => {
                    await provider.connection().insert(usersTable).values({name: 'inner'});

                    throw new Error('inner failure');
                }));
            });

            const rows = await pool.query('SELECT name FROM async_drizzle_test ORDER BY name');
            expect(rows.rows).toEqual([{name: 'inner'}, {name: 'outer'}]);
        });

    });

    // -- Connection release --

    describe('connection release', () => {
        test('failing queries do not exhaust the pool', async () => {
            await withDedicatedStack({
                connections: 2,
                options: {keepPrimaryConnection: false},
            }, async ({provider}) => {
                await provider.connection().insert(usersTable).values({name: 'seed', email: 'clash@example.com'});

                for (let attempt = 0; attempt < 6; attempt++) {
                    const violation = await rejectionOf(
                        provider.connection().insert(usersTable).values({name: 'dup', email: 'clash@example.com'}),
                    );
                    expect(causeOf(violation).code).toBe('23505');

                    const unknownColumn = await rejectionOf(
                        provider.connection().execute(sql`SELECT no_such_column FROM async_drizzle_test`),
                    );
                    expect(causeOf(unknownColumn).code).toBe('42703');

                    const typeMismatch = await rejectionOf(
                        provider.connection().execute(
                            sql`SELECT * FROM async_drizzle_test WHERE age = ${'not-a-number'}`,
                        ),
                    );
                    expect(causeOf(typeMismatch).code).toBe('22P02');
                }

                // Would reject with a connection timeout if any of the 18 failures leaked.
                expect(await provider.connection().select().from(usersTable)).toHaveLength(1);
            });
        });

    });

    // -- Lifecycle --

    describe('lifecycle', () => {

        test('committing an instance that is not a transaction is rejected', async () => {
            await expect(provider.commit(provider.connection())).rejects.toThrow('missing pg connection');
            await expect(provider.rollback(provider.connection())).rejects.toThrow('missing pg connection');
        });

    });

    // -- Security --

    describe('security', () => {
        test('values containing SQL are bound as parameters, never interpolated', async () => {
            const hostileName = "Robert'); DROP TABLE async_drizzle_posts; --";

            await provider.connection().insert(usersTable).values({name: hostileName});

            const found = await provider.connection()
                .select()
                .from(usersTable)
                .where(eq(usersTable.name, hostileName));

            expect(found).toHaveLength(1);
            expect(found[0].name).toBe(hostileName);
            expect(await provider.connection().select().from(postsTable)).toEqual([]);
        });
    });

    // -- Provider options --

    describe('provider options', () => {
        test('snake_case casing maps camelCase properties onto snake_case columns', async () => {
            const snakeCased = new AsyncDrizzleConnectionProvider(asyncPool, {casing: 'snake_case'});

            await snakeCased.connection().insert(implicitNamesTable).values({name: 'Frank'});

            const rows = await snakeCased.connection()
                .select({name: implicitNamesTable.name, createdAt: implicitNamesTable.createdAt})
                .from(implicitNamesTable);

            expect(rows[0].name).toBe('Frank');
            expect(rows[0].createdAt).toBeInstanceOf(Date);

            // Without the option the property name is used verbatim and no such column exists.
            const error = await rejectionOf(provider.connection()
                .select({createdAt: implicitNamesTable.createdAt})
                .from(implicitNamesTable));
            expect(causeOf(error).message).toContain('createdAt');
        });

        test('the logger receives each statement with its parameters', async () => {
            const logged: Array<{query: string; params: unknown[]}> = [];
            const logging = new AsyncDrizzleConnectionProvider(asyncPool, {
                logger: {logQuery: (query, params) => logged.push({query, params})},
            });

            await logging.connection().insert(usersTable).values({name: 'Frank', age: 35});

            expect(logged).toHaveLength(1);
            expect(logged[0].query).toContain('insert into "async_drizzle_test"');
            expect(logged[0].params).toEqual(['Frank', 35]);
        });

        test('extractPgConnection exposes the connection bound to a transaction instance', async () => {
            const trx = await provider.begin();

            expect(extractPgConnection(trx)).toBe(asyncPool.withTransaction());

            await provider.rollback(trx);

            expect(() => extractPgConnection(provider.connection())).toThrow('missing pg connection');
        });

        test('withTransaction instances block drizzle transactions too', async () => {
            const trx = await provider.begin();

            expect(() => provider.withTransaction().transaction(async () => {})).toThrow(
                DrizzleTransactionsNotSupported,
            );

            await provider.rollback(trx);
        });
    });
});
