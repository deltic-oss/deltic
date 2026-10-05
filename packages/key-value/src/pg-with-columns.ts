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

        const tenantId = this.tenantContext?.mustResolve();

        if (tenantId) {
            identityColumns.push('tenant_id');
            values.push(this.tenantIdConversion?.toDatabase(tenantId) ?? tenantId);
            references.push(`$${values.length}`);
        }

        for (const column of this.identityColumns) {
            identityColumns.push(column.columnName);
            values.push(this.databaseValueOf(column, key));
            references.push(`$${values.length}`);
        }

        for (const column of this.storedColumns) {
            valueColums.push(column.columnName);
            values.push(this.databaseValueOf(column, value));
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
        const {condition, values} = this.recordCondition(key);
        const {rows} = await this.query<StoredRecord<Value>>(
            `
            SELECT deltic_payload FROM ${this.tableName}
            WHERE ${condition}
            LIMIT 1
        `,
            values,
        );

        return rows[0]?.deltic_payload.value;
    }

    async remove(key: Key): Promise<void> {
        const {condition, values} = this.recordCondition(key);
        await this.query(
            `
            DELETE FROM ${this.tableName}
            WHERE ${condition}
        `,
            values,
        );
    }

    async clear(): Promise<void> {
        await this.query(`TRUNCATE TABLE ${this.tableName} RESTART IDENTITY CASCADE`);
    }

    /**
     * Selects the record of a key: its tenant, and the identity columns holding the values `persist`
     * writes for that key.
     */
    private recordCondition(key: Key): {condition: string; values: unknown[]} {
        const clauses: string[] = [];
        const values: unknown[] = [];
        const tenantId = this.tenantContext?.mustResolve();

        if (tenantId) {
            values.push(this.tenantIdConversion?.toDatabase(tenantId) ?? tenantId);
            clauses.push(`tenant_id = $${values.length}`);
        }

        for (const column of this.identityColumns) {
            values.push(
                Object.prototype.hasOwnProperty.call(key, column.payloadKey) ? this.databaseValueOf(column, key) : null,
            );
            clauses.push(`${column.columnName} = $${values.length}`);
        }

        return {condition: clauses.join(' AND '), values};
    }

    /**
     * Writing a record and looking it up derive a column's value here, so they cannot disagree.
     */
    private databaseValueOf<Columns extends ObjectType>(
        column: ResolvedColumnAndToDatabaseFn<Columns>,
        source: Columns,
    ): PropertyType {
        const value = source[column.payloadKey];

        return column.toDatabaseValue?.(value) ?? value;
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
