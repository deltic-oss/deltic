import type {AsyncPgPool} from '@deltic/async-pg-pool';
import type {OffsetIdType, OffsetRepository, OffsetType} from './index.js';

type OffsetRecord<Offset extends string | number, Id extends OffsetIdType> = {
    consumer: string;
    identifier: Id;
    offset: Offset;
};

export interface OffsetRepositoryUsingPgOptions {
    /**
     * Optionally schema-qualified. Refused unless it is a plain identifier: the name is part of the
     * statement text, so anything else would run as SQL.
     */
    tableName: string;
    consumerName: string;
    selectForUpdate?: boolean;
}

export class OffsetRepositoryUsingPg<
    Offset extends OffsetType,
    Id extends OffsetIdType = string,
> implements OffsetRepository<Offset, Id> {
    private readonly tableName: string;
    private readonly consumerName: string;
    private readonly selectForUpdate: boolean;

    constructor(
        private readonly pool: AsyncPgPool,
        readonly options: OffsetRepositoryUsingPgOptions,
    ) {
        this.tableName = options.tableName;
        this.consumerName = options.consumerName;
        this.selectForUpdate = options.selectForUpdate ?? false;
    }

    async retrieve(identifier: Id): Promise<Offset | undefined> {
        const conn = await this.pool.primary();

        // FOR UPDATE holds the row against concurrent read-modify-write cycles until the caller's
        // transaction finishes. It goes at the end of the statement; it used to be spliced into the
        // SELECT keyword itself, which made every locking retrieve a syntax error.
        const result = await conn.query<OffsetRecord<Offset, Id>>(
            `SELECT "offset"
                FROM ${this.tableName}
                WHERE consumer = $1 AND identifier = $2
                ${this.selectForUpdate ? 'FOR UPDATE' : ''}`,
            [this.consumerName, identifier],
        );

        return result.rows[0]?.offset;
    }

    async store(identifier: Id, offset: Offset): Promise<void> {
        const conn = await this.pool.primary();

        await conn.query(
            `INSERT INTO ${this.tableName} (consumer, identifier, "offset")
             VALUES ($1, $2, $3) ON CONFLICT (consumer, identifier)
                DO
            UPDATE SET "offset" = EXCLUDED.offset`,
            [this.consumerName, identifier, offset],
        );
    }
}
