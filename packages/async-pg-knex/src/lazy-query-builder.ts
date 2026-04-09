import type {Knex} from 'knex';
import type {AsyncPgPool} from '@deltic/async-pg-pool';
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
 * Executes a buffered query by acquiring a connection, replaying calls, and executing.
 */
async function executeQuery(
    knex: Knex,
    pool: AsyncPgPool,
    tableName: string | undefined,
    bufferedCalls: BufferedCall[],
): Promise<unknown> {
    const connection = await pool.primary();
    const inTransaction = pool.inTransaction();

    try {
        // Build the query
        const initial = tableName ? knex(tableName) : knex.queryBuilder();

        // Replay buffered calls
        const builder = replayBufferedCalls(initial, bufferedCalls);

        // Bind to our connection and execute
        return await builder.connection(connection as any);
    } finally {
        // Release if not in transaction
        if (!inTransaction) {
            await pool.release(connection);
        }
    }
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
    const connection = await pool.primary();
    const inTransaction = pool.inTransaction();

    try {
        return await knex.raw(sql, bindings as any).connection(connection as any);
    } finally {
        if (!inTransaction) {
            await pool.release(connection);
        }
    }
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
