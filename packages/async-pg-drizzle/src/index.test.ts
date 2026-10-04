import {Pool} from 'pg';
import {
    AsyncPgPool,
    asyncPgPoolContextSlot,
    asyncPoolContext,
    TransactionManagerUsingPg,
    type AsyncPgPoolOptions,
    type AsyncPoolContext,
} from '@deltic/async-pg-pool';
import {composeContextSlots} from '@deltic/context';
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
    setup: {connections: number; options?: AsyncPgPoolOptions; scopedToAsyncContext?: true},
    use: (stack: DedicatedStack) => Promise<R>,
): Promise<R> => {
    const pgPool = new Pool({
        ...pgTestCredentials,
        max: setup.connections,
        connectionTimeoutMillis: 1000,
    });
    const context = setup.scopedToAsyncContext
        ? composeContextSlots([asyncPgPoolContextSlot], new AsyncLocalStorage())
        : undefined;
    const asyncPool = new AsyncPgPool(pgPool, {keepConnections: 0, ...setup.options}, context);
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

        test('a transaction manager on the same pool wraps queries made through the provider', async () => {
            const transactions = new TransactionManagerUsingPg(asyncPool);

            await transactions.runInTransaction(async () => {
                await provider.connection().insert(usersTable).values({name: 'Frank'});

                expect(provider.inTransaction()).toBe(true);
                expect((await pool.query('SELECT name FROM async_drizzle_test')).rows).toEqual([]);
            });

            expect((await pool.query('SELECT name FROM async_drizzle_test')).rows).toEqual([{name: 'Frank'}]);
        });

        test('a transaction started through the provider can be finalized by the transaction manager', async () => {
            const transactions = new TransactionManagerUsingPg(asyncPool);
            const trx = await provider.begin();

            await trx.insert(usersTable).values({name: 'Frank'});
            await transactions.rollback();

            expect(provider.inTransaction()).toBe(false);
            expect((await pool.query('SELECT name FROM async_drizzle_test')).rows).toEqual([]);
            await expect(provider.commit(trx)).rejects.toThrow('NOT the known transaction');
        });
    });

    // -- Async context scoping --

    describe('async context scoping', () => {
        test('parallel flows in separate scopes get independent transactions', async () => {
            await withDedicatedStack({connections: 2, scopedToAsyncContext: true}, async ({pgPool, asyncPool, provider}) => {
                const inserted = Promise.withResolvers<void>();
                const observed = Promise.withResolvers<void>();

                const writingFlow = asyncPool.runInIsolatedTransaction(async () => {
                    await provider.connection().insert(usersTable).values({name: 'writing-flow'});
                    inserted.resolve();
                    await observed.promise;
                });

                const readingFlow = asyncPool.runInIsolatedTransaction(async () => {
                    await inserted.promise;
                    const visible = await provider.connection().select().from(usersTable);
                    observed.resolve();

                    return visible;
                });

                const [, visibleToTheReader] = await Promise.all([writingFlow, readingFlow]);

                expect(visibleToTheReader).toEqual([]);
                expect((await pgPool.query('SELECT name FROM async_drizzle_test')).rows).toEqual([
                    {name: 'writing-flow'},
                ]);
            });
        });

        test('queries outside an async context scope are rejected', async () => {
            await withDedicatedStack({connections: 1, scopedToAsyncContext: true}, async ({provider}) => {
                const error = await rejectionOf(provider.connection().select().from(usersTable));

                expect(causeOf(error).message).toContain('No transaction context available');
            });
        });

        test('an isolated transaction commits work performed through the lazy connection', async () => {
            await withDedicatedStack({connections: 2, scopedToAsyncContext: true}, async ({pgPool, asyncPool, provider}) => {
                const created = await asyncPool.runInIsolatedTransaction(async () => {
                    const [user] = await provider.connection()
                        .insert(usersTable)
                        .values({name: 'Frank'})
                        .returning();

                    return user;
                });

                expect(created.name).toBe('Frank');
                expect((await pgPool.query('SELECT name FROM async_drizzle_test')).rows).toEqual([{name: 'Frank'}]);
            });
        });
    });

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

        test('the release hook treats a cleanly rolled back connection as healthy', async () => {
            const releasedWith: unknown[] = [];
            const failure = new Error('domain failure');

            await withDedicatedStack({
                connections: 2,
                options: {
                    releaseHookOnError: true,
                    onRelease: (_connection, error) => {
                        releasedWith.push(error);
                    },
                },
            }, async ({provider}) => {
                await expect(provider.runInTransaction(async () => {
                    await provider.connection().insert(usersTable).values({name: 'Frank'});

                    throw failure;
                })).rejects.toBe(failure);

                // The hook's error parameter signals a broken connection about to be destroyed.
                // A failed unit of work whose ROLLBACK succeeded releases a healthy connection, so
                // the hook runs its reset with no error; the cause itself is reported through the
                // transaction-management layer, not the connection lifecycle.
                expect(releasedWith).toEqual([undefined]);
            });
        });

        test('a constraint violation rolls the whole transaction back', async () => {
            const caught = await rejectionOf(provider.runInTransaction(async () => {
                await provider.connection().insert(usersTable).values({name: 'first', email: 'clash@example.com'});
                await provider.connection().insert(usersTable).values({name: 'second', email: 'clash@example.com'});
            }));

            expect(causeOf(caught).code).toBe('23505');
            expect((await pool.query('SELECT name FROM async_drizzle_test')).rows).toEqual([]);
        });

        test('the pool recovers from a constraint violation inside a transaction', async () => {
            await withDedicatedStack({connections: 1}, async ({provider}) => {
                await expect(provider.runInTransaction(async () => {
                    await provider.connection().insert(usersTable).values({name: 'first', email: 'clash@example.com'});
                    await provider.connection().insert(usersTable).values({name: 'second', email: 'clash@example.com'});
                })).rejects.toThrow();

                // The aborted connection must not be handed to the next flow in its poisoned state.
                const afterwards = await provider.connection().select().from(usersTable);
                expect(afterwards).toEqual([]);
            });
        });

        it('reports a failure when the server discards an aborted transaction on commit', async () => {
            await withDedicatedStack({connections: 2}, async ({pgPool, provider}) => {
                const outcome = await provider.runInTransaction(async () => {
                    await provider.connection().insert(usersTable).values({name: 'kept', email: 'clash@example.com'});
                    // A caller that treats a duplicate as harmless leaves the transaction aborted.
                    await rejectionOf(
                        provider.connection().insert(usersTable).values({name: 'ignored', email: 'clash@example.com'}),
                    );
                }).then(() => 'resolved', () => 'rejected');

                const stored = await pgPool.query('SELECT name FROM async_drizzle_test');

                expect(stored.rows).toEqual([]);
                expect(outcome).toBe('rejected');
            });
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

        test('a second begin() queues behind the active transaction', async () => {
            // Queueing is what lets two concurrent flows share a context. It is also why a flow
            // that awaits a transaction it would itself have to finalise deadlocks — use
            // runInTransaction to compose, and transactionWaitTimeoutMs to bound the wait.
            await withDedicatedStack({connections: 2}, async ({provider}) => {
                const outer = await provider.begin();
                const nested = provider.begin();

                expect(await settlesWithin(nested, 300)).toBe('timed out');

                // Finalizing the outer transaction lets the queued begin through.
                await provider.rollback(outer);
                await provider.rollback(await nested);
            });
        });

        test('a configured wait turns a queued begin() into an error', async () => {
            await withDedicatedStack({
                connections: 2,
                options: {transactionWaitTimeoutMs: 100},
            }, async ({provider}) => {
                const outer = await provider.begin();

                await expect(provider.begin()).rejects.toThrow();

                await provider.rollback(outer);
            });
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

        test('concurrent lazy queries share a single pooled connection', async () => {
            await withDedicatedStack({connections: 1}, async ({provider}) => {
                await Promise.all([
                    provider.connection().insert(usersTable).values({name: 'one'}),
                    provider.connection().select().from(usersTable),
                    provider.connection().insert(usersTable).values({name: 'two'}),
                    provider.connection().select().from(usersTable),
                    provider.connection().execute(sql`SELECT 1`),
                ]);

                expect(await provider.connection().select().from(usersTable)).toHaveLength(2);
            });
        });

        test('a transaction that fails to start releases its connection', async () => {
            await withDedicatedStack({
                connections: 1,
                options: {keepPrimaryConnection: false},
            }, async ({provider}) => {
                await expect(provider.begin('BEGIN ISOLATION LEVEL BOGUS')).rejects.toThrow(/syntax error/);
                expect(provider.inTransaction()).toBe(false);

                // Would reject with a connection timeout if the failed begin leaked its connection.
                expect(await provider.connection().select().from(usersTable)).toEqual([]);
            });
        });

        it('releases the transaction lock when the begin query fails', async () => {
            await withDedicatedStack({connections: 2}, async ({provider}) => {
                await expect(provider.begin('BEGIN ISOLATION LEVEL BOGUS')).rejects.toThrow(/syntax error/);

                expect(await settlesWithin(provider.begin(), 300)).toBe('settled');
            });
        });

        it('reports the forgotten transaction when flushing instead of blocking', async () => {
            // Flushing used to queue behind the very transaction it wanted to report on, so teardown
            // hung forever. The pool now rolls the transaction back, reclaims its connection and
            // rejects — the single connection here is what proves it was reclaimed.
            await withDedicatedStack({connections: 1}, async ({pgPool, asyncPool, provider}) => {
                const forgotten = await provider.begin();
                await forgotten.insert(usersTable).values({name: 'orphan'});

                const flush = asyncPool.flush();

                expect(await settlesWithin(flush, 300)).toBe('settled');
                await expect(flush).rejects.toThrow('a transaction was still open');

                const rows = await pgPool.query('SELECT name FROM async_drizzle_test');
                expect(rows.rows).toEqual([]);
            });
        });
    });

    // -- Lifecycle --

    describe('lifecycle', () => {
        test('queries after the pool context is flushed are rejected', async () => {
            await withDedicatedStack({connections: 2}, async ({asyncPool, provider}) => {
                await provider.connection().select().from(usersTable);
                await asyncPool.flush();

                const error = await rejectionOf(provider.connection().select().from(usersTable));
                expect(causeOf(error).message).toContain('already flushed');
            });
        });

        test('begin after the pool context is flushed is rejected', async () => {
            await withDedicatedStack({connections: 2}, async ({asyncPool, provider}) => {
                await asyncPool.flush();

                await expect(provider.begin()).rejects.toThrow('already flushed');
            });
        });

        test('flushing twice is a no-op', async () => {
            await withDedicatedStack({connections: 2}, async ({asyncPool, provider}) => {
                await provider.connection().select().from(usersTable);

                await asyncPool.flush();
                await asyncPool.flush();

                expect(asyncPool.wasFlushed()).toBe(true);
            });
        });

        test('committing the same transaction twice is rejected', async () => {
            const trx = await provider.begin();
            await provider.commit(trx);

            await expect(provider.commit(trx)).rejects.toThrow('NOT the known transaction');
            await expect(provider.rollback(trx)).rejects.toThrow('NOT the known transaction');
            expect(provider.inTransaction()).toBe(false);
        });

        test('committing an instance that is not a transaction is rejected', async () => {
            await expect(provider.commit(provider.connection())).rejects.toThrow('missing pg connection');
            await expect(provider.rollback(provider.connection())).rejects.toThrow('missing pg connection');
        });

        test('rolling back with an error keeps the connection pooled', async () => {
            await withDedicatedStack({connections: 2}, async ({pgPool, provider}) => {
                const trx = await provider.begin();
                await trx.insert(usersTable).values({name: 'discarded'});

                await provider.rollback(trx, new Error('flow failed'));

                // The cause explains the rollback; it is not a verdict on the connection. The
                // ROLLBACK succeeded, so the session is clean, stays pooled, and the work is gone.
                expect(pgPool.totalCount).toBe(1);
                expect(pgPool.idleCount).toBe(1);
                expect((await pgPool.query('SELECT name FROM async_drizzle_test')).rows).toEqual([]);
            });
        });

        // see .claude-work/issues/async-pg-drizzle-committed-transaction-stays-usable.md
        it.fails('rejects queries issued on a committed transaction instance', async () => {
            await withDedicatedStack({connections: 2}, async ({pgPool, provider}) => {
                const trx = await provider.begin();
                await trx.insert(usersTable).values({name: 'committed'});
                await provider.commit(trx);

                const outcome = await trx.insert(usersTable).values({name: 'after-commit'})
                    .then(() => 'accepted', () => 'rejected');

                expect(outcome).toBe('rejected');
                expect((await pgPool.query('SELECT name FROM async_drizzle_test')).rows).toEqual([
                    {name: 'committed'},
                ]);
            });
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

        test('binding a tenant id in a connection hook prevents the injection interpolation allows', async () => {
            const hostileTenantId = "acme'; SET app.injected = 'yes'; SET app.tenant_id = 'acme";
            const readSettings = sql`
                SELECT current_setting('app.injected', true) AS injected,
                       current_setting('app.tenant_id', true) AS tenant
            `;

            // The pattern the README documents interpolates the value, so it runs as statements.
            await withDedicatedStack({
                connections: 1,
                options: {onClaim: client => client.query(`SET app.tenant_id = '${hostileTenantId}'`)},
            }, async ({provider}) => {
                const interpolated = await provider.connection().execute(readSettings);

                expect(interpolated.rows[0].injected).toBe('yes');
                expect(interpolated.rows[0].tenant).toBe('acme');
            });

            // Binding the value keeps it data.
            await withDedicatedStack({
                connections: 1,
                options: {
                    onClaim: client => client.query('SELECT set_config($1, $2, false)', [
                        'app.tenant_id',
                        hostileTenantId,
                    ]),
                },
            }, async ({provider}) => {
                const bound = await provider.connection().execute(readSettings);

                expect(bound.rows[0].injected).toBe(null);
                expect(bound.rows[0].tenant).toBe(hostileTenantId);
            });
        });

        // see .claude-work/issues/async-pg-drizzle-query-errors-disclose-parameters.md
        it.fails('keeps parameter values out of query error messages', async () => {
            await provider.connection().insert(usersTable).values({name: 'Frank', email: 'frank@example.com'});

            const error = await rejectionOf(
                provider.connection().insert(usersTable).values({name: 'Impostor', email: 'frank@example.com'}),
            );

            expect(causeOf(error).code).toBe('23505');
            expect(error.message).not.toContain('frank@example.com');
        });

        // see .claude-work/issues/async-pg-drizzle-release-failure-masks-query-error.md
        it.fails('preserves the query error when releasing the connection fails', async () => {
            await withDedicatedStack({
                connections: 2,
                options: {
                    keepPrimaryConnection: false,
                    onRelease: () => {
                        throw new Error('reset query failed');
                    },
                },
            }, async ({provider}) => {
                await provider.connection().insert(usersTable).values({name: 'seed', email: 'clash@example.com'});

                const error = await rejectionOf(
                    provider.connection().insert(usersTable).values({name: 'dup', email: 'clash@example.com'}),
                );

                expect(causeOf(error).code).toBe('23505');
            });
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
