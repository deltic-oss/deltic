import type {Knex} from 'knex';
import type {Connection as PgConnection} from '@deltic/async-pg-pool';
import type {Transaction} from './types.js';

/**
 * Symbol used to store the pg connection on transaction wrappers.
 */
export const pgConnectionSymbol = Symbol.for('@deltic/async-pg-knex/connection');

/**
 * Extended Transaction type that includes the stored pg connection.
 */
interface TransactionWithConnection extends Transaction {
    [pgConnectionSymbol]: PgConnection;
}

/**
 * Properties that should be delegated directly to the knex instance
 * rather than starting a query builder chain.
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
 * Creates a Transaction wrapper that binds all queries to the given pg connection.
 * Unlike the lazy Connection, queries execute immediately since we already have the connection.
 */
export function createTransactionWrapper(knex: Knex, pgConnection: PgConnection): Transaction {
    const handler: ProxyHandler<object> = {
        // Handle trx('tableName') syntax
        apply(_target, _thisArg, args: [string?]) {
            const tableName = args[0];
            if (tableName) {
                return knex(tableName).connection(pgConnection as any);
            }
            return knex.queryBuilder().connection(pgConnection as any);
        },

        get(_target, prop) {
            // Return the pg connection for extraction
            if (prop === pgConnectionSymbol) {
                return pgConnection;
            }

            // For raw queries
            if (prop === 'raw') {
                return (sql: string, bindings?: Knex.RawBinding | Knex.RawBinding[]) => {
                    return knex.raw(sql, bindings as any).connection(pgConnection as any);
                };
            }

            // The transaction wrapper is NOT a thenable — prevent Promise unwrapping
            if (prop === 'then' || prop === 'catch' || prop === 'finally') {
                return undefined;
            }

            // For known knex-level properties, delegate directly
            if (typeof prop === 'string' && KNEX_DELEGATE_PROPERTIES.has(prop)) {
                return (knex as any)[prop];
            }

            // For symbols, delegate to knex
            if (typeof prop === 'symbol') {
                return (knex as any)[prop];
            }

            // Everything else starts a query builder chain bound to the transaction connection
            return (...args: unknown[]) => {
                const builder = knex.queryBuilder();
                (builder as any)[prop](...args);
                return builder.connection(pgConnection as any);
            };
        },
    };

    // Use a function as the proxy target so it's callable
    return new Proxy(function () {}, handler) as unknown as Transaction;
}

/**
 * Extracts the pg connection from a Transaction wrapper.
 * Throws if the transaction doesn't have a stored connection.
 */
export function extractPgConnection(trx: Transaction): PgConnection {
    const connection = (trx as TransactionWithConnection)[pgConnectionSymbol];

    if (!connection) {
        throw new Error('Invalid transaction object - missing pg connection');
    }

    return connection;
}
