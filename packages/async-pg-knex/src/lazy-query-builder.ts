import type {Knex} from 'knex';
import type {AsyncPgPool, Connection as PgConnection} from '@deltic/async-pg-pool';
import type {BufferedCall, Connection} from './types.js';

/**
 * Symbol used to identify and materialize lazy query builder proxies.
 * When accessed on a lazy proxy, returns a function that creates the
 * corresponding real Knex.QueryBuilder.
 */
const MATERIALIZE = Symbol('materialize');

/**
 * Properties that should be delegated directly to the knex instance
 * rather than creating a lazy query builder.
 */
const KNEX_DELEGATE_PROPERTIES = new Set([
    'client',
    'schema',
    'migrate',
    'seed',
    'destroy',
    'ref',
    'fn',
    'queryBuilder',
    'toString',
    'toSQL',
]);

/**
 * Creates a lazy Connection that defers actual database connection
 * acquisition until a query is awaited.
 */
export function createLazyConnection(knex: Knex, pool: AsyncPgPool): Connection {
    const handler: ProxyHandler<object> = {
        // Handle connection('tableName') syntax
        apply(_target, _thisArg, args: [string?]) {
            const tableName = args[0];
            return createLazyQueryBuilder(knex, pool, tableName);
        },

        get(_target, prop) {
            // Schema statements run on the ambient connection like every other query. knex's own
            // builder would ask knex for a connection, and the knex instance deliberately has no pool.
            if (prop === 'schema') {
                return createLazySchemaBuilder(knex, pool);
            }

            // For raw queries
            if (prop === 'raw') {
                return (sql: string, bindings?: Knex.RawBinding | Knex.RawBinding[]) => {
                    return createLazyRawBuilder(knex, pool, sql, bindings);
                };
            }

            // For known knex-level properties, delegate directly
            if (typeof prop === 'string' && KNEX_DELEGATE_PROPERTIES.has(prop)) {
                return (knex as any)[prop];
            }

            // For symbols, delegate to knex
            if (typeof prop === 'symbol') {
                return (knex as any)[prop];
            }

            // Everything else starts a query builder chain
            return (...args: unknown[]) => {
                return createLazyQueryBuilder(knex, pool, undefined, [{method: prop, args}]);
            };
        },
    };

    // Use a function as the proxy target so it's callable
    return new Proxy(function () {}, handler) as unknown as Connection;
}

/**
 * Creates a Proxy that buffers query builder method calls and only
 * executes when the promise is awaited (via .then()).
 */
export function createLazyQueryBuilder(
    knex: Knex,
    pool: AsyncPgPool,
    tableName?: string,
    initialCalls: BufferedCall[] = [],
): Knex.QueryBuilder {
    const bufferedCalls: BufferedCall[] = [...initialCalls];

    const handler: ProxyHandler<object> = {
        get(_target, prop, receiver) {
            // Allow materializing this proxy into a real Knex query builder
            if (prop === MATERIALIZE) {
                return () => {
                    const builder = tableName ? knex(tableName) : knex.queryBuilder();
                    return replayBufferedCalls(builder, bufferedCalls);
                };
            }

            // Handle thenable - called when awaited
            if (prop === 'then') {
                return (
                    onFulfilled?: (value: unknown) => unknown,
                    onRejected?: (reason: unknown) => unknown,
                ) => {
                    return executeQuery(knex, pool, tableName, bufferedCalls).then(onFulfilled, onRejected);
                };
            }

            if (prop === 'catch') {
                return (onRejected?: (reason: unknown) => unknown) => {
                    return executeQuery(knex, pool, tableName, bufferedCalls).catch(onRejected);
                };
            }

            if (prop === 'finally') {
                return (onFinally?: () => void) => {
                    return executeQuery(knex, pool, tableName, bufferedCalls).finally(onFinally);
                };
            }

            // toSQL() doesn't need a connection - can be called synchronously
            if (prop === 'toSQL') {
                return () => {
                    const builder = tableName ? knex(tableName) : knex.queryBuilder();
                    const result = replayBufferedCalls(builder, bufferedCalls);
                    return result.toSQL();
                };
            }

            // toString() for debugging
            if (prop === 'toString') {
                return () => {
                    const builder = tableName ? knex(tableName) : knex.queryBuilder();
                    const result = replayBufferedCalls(builder, bufferedCalls);
                    return result.toString();
                };
            }

            // clone() creates a new independent lazy query builder
            if (prop === 'clone') {
                return () => {
                    // Create a deep copy of buffered calls to ensure independence
                    return createLazyQueryBuilder(knex, pool, tableName, bufferedCalls.map(call => ({
                        ...call,
                        args: [...call.args],
                    })));
                };
            }

            // Buffer all other method calls and return proxy for chaining
            return (...args: unknown[]) => {
                bufferedCalls.push({method: prop, args});
                return receiver;
            };
        },
    };

    return new Proxy({}, handler) as unknown as Knex.QueryBuilder;
}

/**
 * Creates a schema builder that acquires its connection only when it runs. The builder is knex's
 * own, so every schema method works as documented; only running it is redirected to the ambient
 * connection — the transaction's when one is active, which makes the DDL part of it.
 */
function createLazySchemaBuilder(knex: Knex, pool: AsyncPgPool): Knex.SchemaBuilder {
    const builder = knex.schema;
    const run = builder.then.bind(builder) as () => Promise<unknown>;
    const execute = (): Promise<unknown> => runOnAmbientConnection(pool, connection => {
        builder.connection(connection as any);

        return run();
    });

    return Object.assign(builder, {
        then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
            execute().then(onFulfilled, onRejected),
        catch: (onRejected?: (reason: unknown) => unknown) => execute().catch(onRejected),
        finally: (onFinally?: () => void) => execute().finally(onFinally),
    });
}

/**
 * Creates a Proxy for raw queries that defers execution until awaited.
 */
export function createLazyRawBuilder(
    knex: Knex,
    pool: AsyncPgPool,
    sql: string,
    bindings?: Knex.RawBinding | Knex.RawBinding[],
): Knex.Raw {
    const handler: ProxyHandler<object> = {
        get(_target, prop) {
            // Handle thenable
            if (prop === 'then') {
                return (
                    onFulfilled?: (value: unknown) => unknown,
                    onRejected?: (reason: unknown) => unknown,
                ) => {
                    return executeRawQuery(knex, pool, sql, bindings).then(onFulfilled, onRejected);
                };
            }

            if (prop === 'catch') {
                return (onRejected?: (reason: unknown) => unknown) => {
                    return executeRawQuery(knex, pool, sql, bindings).catch(onRejected);
                };
            }

            if (prop === 'finally') {
                return (onFinally?: () => void) => {
                    return executeRawQuery(knex, pool, sql, bindings).finally(onFinally);
                };
            }

            // toSQL() doesn't need a connection
            if (prop === 'toSQL') {
                return () => {
                    return knex.raw(sql, bindings as any).toSQL();
                };
            }

            // toString() for debugging
            if (prop === 'toString') {
                return () => {
                    return knex.raw(sql, bindings as any).toString();
                };
            }

            // Delegate other properties to the raw builder
            return (knex.raw(sql, bindings as any) as any)[prop];
        },
    };

    return new Proxy({}, handler) as unknown as Knex.Raw;
}

/**
 * Runs work on the ambient connection: the active transaction's, or one resolved for this piece of
 * work and released after it.
 */
async function runOnAmbientConnection<R>(
    pool: AsyncPgPool,
    work: (connection: PgConnection) => Promise<R>,
): Promise<R> {
    const connection = await pool.primary();
    const inTransaction = pool.inTransaction();

    try {
        return await work(connection);
    } finally {
        // Release if not in transaction
        if (!inTransaction) {
            await pool.release(connection);
        }
    }
}

/**
 * Executes a buffered query by acquiring a connection, replaying calls, and executing.
 */
async function executeQuery(
    knex: Knex,
    pool: AsyncPgPool,
    tableName: string | undefined,
    bufferedCalls: BufferedCall[],
): Promise<unknown> {
    return runOnAmbientConnection(pool, async connection => {
        // Build the query
        const initial = tableName ? knex(tableName) : knex.queryBuilder();

        // Replay buffered calls
        const builder = replayBufferedCalls(initial, bufferedCalls);

        // Bind to our connection and execute
        return await builder.connection(connection as any);
    });
}

/**
 * Executes a raw query by acquiring a connection.
 */
async function executeRawQuery(
    knex: Knex,
    pool: AsyncPgPool,
    sql: string,
    bindings?: Knex.RawBinding | Knex.RawBinding[],
): Promise<unknown> {
    return runOnAmbientConnection(pool, async connection => {
        return await knex.raw(sql, bindings as any).connection(connection as any);
    });
}

/**
 * Materializes a value if it is a lazy query builder proxy,
 * converting it into a real Knex query builder.
 */
function materializeArg(arg: unknown): unknown {
    if (arg != null && typeof arg === 'object') {
        const materialize = (arg as any)[MATERIALIZE];
        if (typeof materialize === 'function') {
            return materialize();
        }
    }
    return arg;
}

/**
 * Replays buffered method calls on a real query builder.
 * Returns the final builder, which may differ from the initial one
 * when methods like onConflict() return a different object.
 */
function replayBufferedCalls(builder: Knex.QueryBuilder, calls: BufferedCall[]): Knex.QueryBuilder {
    let current: any = builder;
    for (const {method, args} of calls) {
        current = current[method](...args.map(materializeArg)) ?? current;
    }
    return current;
}
