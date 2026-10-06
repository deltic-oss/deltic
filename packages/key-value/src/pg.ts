import {
    type KeyConversion,
    type KeyNormalisation,
    type KeyType,
    type KeyValueStore,
    SortingKeyNormalisation,
    type ValueType,
} from './index.js';
import type {QueryResult, QueryResultRow} from 'pg';
import type {AsyncPgPool} from '@deltic/async-pg-pool';
import type {ValueReader} from '@deltic/context';
import type {IdConversion} from '@deltic/uid';

type StoredRecord<V> = {
    key: string | number;
    // This nesting is needed to store arbitrary values, it requires a top-level array or object
    value: {value: V};
};

export interface KeyValueStoreUsingPgOptions<
    Key extends KeyType,
    DatabaseKey extends string | number,
    TenantId extends string | number,
> {
    tableName: string;
    /**
     * Brings a key into the form the store addresses it by. The default sorts the properties of
     * object keys, so the order a key was built in does not matter.
     */
    keyNormalisation?: KeyNormalisation<Key>;
    /**
     * Turns a normalised key into the value stored in the `key` column. The default hands the key to
     * `pg` as it is, which stores an object as its JSON.
     */
    keyConversion?: KeyConversion<Key, DatabaseKey>;

    tenantContext?: ValueReader<TenantId>;
    tenantIdConversion?: IdConversion<TenantId>;
}

export class KeyValueStoreUsingPg<
    Key extends KeyType,
    Value extends ValueType,
    DatabaseKey extends string | number = string | number,
    TenantId extends string | number = string | number,
> implements KeyValueStore<Key, Value> {
    private readonly tableName: string;
    private readonly keyNormalisation: KeyNormalisation<Key>;
    private readonly keyConversion: KeyConversion<Key, DatabaseKey>;
    private readonly tenantContext?: ValueReader<TenantId>;
    private readonly tenantIdConversion?: IdConversion<TenantId>;

    constructor(
        private readonly pool: AsyncPgPool,
        readonly options: KeyValueStoreUsingPgOptions<Key, DatabaseKey, TenantId>,
    ) {
        this.tableName = options.tableName;
        this.keyNormalisation = options.keyNormalisation ?? new SortingKeyNormalisation<Key>();
        this.keyConversion = options.keyConversion ?? (key => key as unknown as DatabaseKey);
        this.tenantContext = options.tenantContext;
        this.tenantIdConversion = options.tenantIdConversion;
    }

    async persist(key: Key, value: Value): Promise<void> {
        const resolvedKey = this.databaseKey(key);
        const tenantId = this.databaseTenantId();
        const values: any[] = [resolvedKey, {value}];
        const references: string[] = ['$1', '$2'];
        const uniqueColumns = ['"key"'];

        if (tenantId !== undefined) {
            references.push('$3');
            uniqueColumns.unshift('tenant_id');
            values.unshift(tenantId);
        }

        await this.query(
            `
            INSERT INTO ${this.tableName} (${uniqueColumns.join(', ')}, "value")
            VALUES (${references.join(', ')}) ON CONFLICT (tenant_id, "key") DO
            UPDATE set "value" = EXCLUDED."value"
        `,
            values,
        );
    }

    async retrieve(key: Key): Promise<Value | undefined> {
        const {condition, values} = this.keyCondition(this.databaseKey(key));
        const result = await this.query<StoredRecord<Value>>(
            `
            SELECT "value"
            from ${this.tableName}
            WHERE ${condition}
            LIMIT 1`,
            values,
        );

        return result.rows[0]?.value?.value;
    }

    async remove(key: Key): Promise<void> {
        const {condition, values} = this.keyCondition(this.databaseKey(key));
        await this.query(`DELETE FROM ${this.tableName} WHERE ${condition}`, values);
    }

    async clear(): Promise<void> {
        const tenantId = this.databaseTenantId();

        if (tenantId === undefined) {
            await this.query(`DELETE FROM ${this.tableName}`);
        } else {
            await this.query(`DELETE FROM ${this.tableName} WHERE tenant_id = $1`, [tenantId]);
        }
    }

    private databaseKey(key: Key): DatabaseKey {
        return this.keyConversion(this.keyNormalisation.normalise(key));
    }

    private keyCondition(resolvedKey: DatabaseKey): {condition: string; values: unknown[]} {
        const tenantId = this.databaseTenantId();

        if (tenantId === undefined) {
            return {condition: '"key" = $1', values: [resolvedKey]};
        }

        return {condition: '"key" = $1 AND tenant_id = $2', values: [resolvedKey, tenantId]};
    }

    /**
     * A store with a tenant context is scoped to the current tenant in every operation and refuses to
     * operate when no tenant can be resolved.
     */
    private databaseTenantId(): string | number | undefined {
        if (this.tenantContext === undefined) {
            return undefined;
        }

        const tenantId = this.tenantContext.mustResolve();

        return this.tenantIdConversion === undefined ? tenantId : this.tenantIdConversion.toDatabase(tenantId);
    }

    private async query<Row extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<Row>> {
        const connection = await this.pool.primary();
        const inTransaction = this.pool.inTransaction();

        try {
            return await connection.query<Row>(sql, values);
        } finally {
            // The connection of an open transaction belongs to whoever finalises the transaction
            if (!inTransaction) {
                await this.pool.release(connection);
            }
        }
    }
}

export function createKeyValueSchemaQuery(tableName: string, ifNotExists: boolean = false): string {
    return `
        CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS' : ''} ${tableName} (
            tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
            "key" VARCHAR(255),
            "value" JSON,
            PRIMARY KEY (tenant_id, "key")
        );
    `;
}
