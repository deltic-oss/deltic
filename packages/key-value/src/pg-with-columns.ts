import type {KeyValueStore} from './index.js';
import type {QueryResult, QueryResultRow} from 'pg';
import type {AsyncPgPool} from '@deltic/async-pg-pool';
import type {ValueReader} from '@deltic/context';
import type {IdConversion} from '@deltic/uid';

export type PropertyType = string | number | boolean | null | undefined | ObjectType | Array<PropertyType>;
export type ObjectType = {[index: string | number]: PropertyType};
export type KeyType<Key extends ObjectType> = {
    [K in keyof Key]: K extends 'deltic_payload' ? never : Key[K];
};

type ColumnAndToDatabaseFn<Columns extends ObjectType> = {
    [Key in keyof Columns]: {
        payloadKey: Key;
        columnName?: string; // optionally name the column something else
        toDatabaseValue?(value: Columns[Key]): PropertyType;
    };
}[keyof Columns];
type ResolvedColumnAndToDatabaseFn<Columns extends ObjectType> = {
    [Key in keyof Columns]: {
        payloadKey: Key;
        columnName: string;
        toDatabaseValue?(value: Columns[Key]): PropertyType;
    };
}[keyof Columns];
type Column<Columns extends ObjectType> = keyof Columns | ColumnAndToDatabaseFn<Columns>;

export type StoredRecord<Value extends ObjectType> = {
    deltic_payload: {value: Value};
} & {
    [index: string | number | symbol]: any;
};

export class KeyValueStoreWithColumnsUsingPg<
    Key extends KeyType<Key>,
    Value extends ObjectType,
    TenantId extends string | number = string | number,
> implements KeyValueStore<Key, Value> {
    private readonly identityColumns: ResolvedColumnAndToDatabaseFn<Key>[];
    private readonly storedColumns: ResolvedColumnAndToDatabaseFn<Value>[];

    constructor(
        private readonly pool: AsyncPgPool,
        private readonly tableName: string,
        identityKeys: Column<Key>[],
        storedKeys: Column<Value>[],
        private readonly tenantContext?: ValueReader<TenantId>,
        private readonly tenantIdConversion?: IdConversion<TenantId>,
    ) {
        this.identityColumns = identityKeys.map(key => this.resolveColumnParameter<Key>(key));
        this.storedColumns = storedKeys.map(key => this.resolveColumnParameter<Value>(key));
    }

    async persist(key: Key, value: Value): Promise<void> {
        const identityColumns: string[] = [];
        const valueColums: string[] = [];
        const references: string[] = [];
        const values: any[] = [];

        const tenantId = this.databaseTenantId();

        if (tenantId !== undefined) {
            identityColumns.push('tenant_id');
            values.push(tenantId);
            references.push(`$${values.length}`);
        }

        for (const {payloadKey, columnName, toDatabaseValue} of this.identityColumns) {
            identityColumns.push(columnName);
            const columnValue = key[payloadKey];
            values.push(toDatabaseValue?.(columnValue) ?? columnValue);
            references.push(`$${values.length}`);
        }

        for (const {payloadKey, columnName, toDatabaseValue} of this.storedColumns) {
            valueColums.push(columnName);
            const columnValue = value[payloadKey];
            values.push(toDatabaseValue?.(columnValue) ?? columnValue);
            references.push(`$${values.length}`);
        }

        valueColums.push('deltic_payload');
        values.push({value});
        references.push(`$${values.length}`);

        await this.query(
            `
            INSERT INTO ${this.tableName} (${[...identityColumns, ...valueColums].map(name => `"${name}"`).join(', ')})
                VALUES (${references.join(', ')})
            ON CONFLICT (${identityColumns.join(', ')}) DO UPDATE
                SET ${valueColums.map(name => `"${name}" = EXCLUDED."${name}"`).join(', ')}
        `,
            values,
        );
    }

    async retrieve(key: Key): Promise<Value | undefined> {
        const whereClauses: string[] = [];
        const values: any[] = [];
        const tenantId = this.databaseTenantId();

        if (tenantId !== undefined) {
            values.push(tenantId);
            whereClauses.push(`tenant_id = $${values.length}`);
        }

        for (const {payloadKey, columnName, toDatabaseValue} of this.identityColumns) {
            values.push(
                Object.prototype.hasOwnProperty.call(key, payloadKey)
                    ? (toDatabaseValue?.(key[payloadKey]) ?? payloadKey)
                    : null,
            );
            whereClauses.push(`${columnName} = $${values.length}`);
        }

        const {rows} = await this.query<StoredRecord<Value>>(
            `
            SELECT deltic_payload FROM ${this.tableName}
            WHERE ${whereClauses.join(' AND ')}
            LIMIT 1
        `,
            values,
        );

        return rows[0]?.deltic_payload.value;
    }

    async remove(key: Key): Promise<void> {
        const whereClauses: string[] = [];
        const values: any[] = [];
        const tenantId = this.databaseTenantId();

        if (tenantId !== undefined) {
            values.push(tenantId);
            whereClauses.push(`tenant_id = $${values.length}`);
        }

        for (const {payloadKey, columnName, toDatabaseValue} of this.identityColumns) {
            values.push(
                Object.prototype.hasOwnProperty.call(key, payloadKey)
                    ? (toDatabaseValue?.(key[payloadKey]) ?? payloadKey)
                    : null,
            );
            whereClauses.push(`${columnName} = $${values.length}`);
        }

        await this.query(
            `
            DELETE FROM ${this.tableName}
            WHERE ${whereClauses.join(' AND ')}
        `,
            values,
        );
    }

    async clear(): Promise<void> {
        const tenantId = this.databaseTenantId();

        if (tenantId === undefined) {
            await this.query(`DELETE FROM ${this.tableName}`);
        } else {
            await this.query(`DELETE FROM ${this.tableName} WHERE tenant_id = $1`, [tenantId]);
        }
    }

    /**
     * A store with a tenant context is scoped to the current tenant in every operation and refuses to
     * operate when no tenant can be resolved. Tenant ids such as `0` and `''` are scoped like any other.
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

        try {
            return await connection.query<Row>(sql, values);
        } finally {
            await this.pool.release(connection);
        }
    }

    private resolveColumnParameter<Columns extends ObjectType>(
        column: Column<Columns>,
    ): ResolvedColumnAndToDatabaseFn<Columns> {
        if (typeof column === 'object') {
            return {
                ...column,
                columnName: column.columnName || column.payloadKey,
            };
        }
        // allow just a string to be passed, toDatabaseValue does nothing in this case
        return {
            payloadKey: column,
            columnName: column.toString(),
            toDatabaseValue: value => value,
        };
    }
}
