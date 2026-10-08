import type {
    AggregateIdWithStreamOffset,
    AnyMessageFrom,
    IdPaginationOptions,
    MessageRepository,
    MessagesFrom,
    StreamDefinition,
} from '../index.js';
import type {AsyncPgPool} from '@deltic/async-pg-pool';
import {type ValueReader} from '@deltic/context';
import {messageWithHeader} from '../helpers.js';
import type {IdConversion} from '@deltic/uid';

interface MessageRecord<Stream extends StreamDefinition> {
    id: number;
    version: number;
    event_type: string;
    aggregate_root_id: string;
    tenant_id: string | null;
    payload: AnyMessageFrom<Stream>;
}

export interface NotificationConfiguration {
    style: 'both' | 'channel' | 'central' | 'none';
    channelName?: string;
}

export interface MessageRepositoryUsingPgOptions<Stream extends StreamDefinition> {
    readonly idConversion?: IdConversion<Stream['aggregateRootId']>;
    readonly tenantIdConversion?: IdConversion<string | number>;
    readonly tenantContext?: ValueReader<string>;
    readonly notificationConfiguration?: NotificationConfiguration;
}

export class MessageRepositoryUsingPg<Stream extends StreamDefinition> implements MessageRepository<Stream> {
    private readonly idConversion?: IdConversion<Stream['aggregateRootId']>;
    private readonly tenantIdConversion?: IdConversion<string | number>;
    private readonly tenantContext?: ValueReader<string>;
    private readonly notificationConfiguration: NotificationConfiguration;

    constructor(
        private readonly pool: AsyncPgPool,
        private readonly tableName: string,
        readonly options: MessageRepositoryUsingPgOptions<Stream> = {},
    ) {
        this.idConversion = options.idConversion;
        this.tenantIdConversion = options.tenantIdConversion;
        this.tenantContext = options.tenantContext;
        this.notificationConfiguration = options.notificationConfiguration ?? {style: 'none'};
    }

    retrieveAllAfterVersion(
        id: Stream['aggregateRootId'],
        version: number,
    ): AsyncGenerator<AnyMessageFrom<Stream>, any, unknown> {
        return this.retrieveBetweenVersions(id, version, 0);
    }

    retrieveAllUntilVersion(
        id: Stream['aggregateRootId'],
        version: number,
    ): AsyncGenerator<AnyMessageFrom<Stream>, any, unknown> {
        return this.retrieveBetweenVersions(id, 0, version);
    }

    async *retrieveBetweenVersions(
        id: Stream['aggregateRootId'],
        after: number,
        before: number,
    ): AsyncGenerator<AnyMessageFrom<Stream>, any, unknown> {
        const tenantId = this.tenantContext?.mustResolve();
        const connection = await this.pool.primary();

        const values: any[] = [];
        const whereClauses: string[] = [];

        /**
         * The where clauses are ordered to match the column order of the primary reconstitution
         * order, which comes in two shapes.
         *
         * For tenant-scoped tables: tenant_id, aggregate_root_id, version ASC
         * For tenant-less tables: aggregate_root_id, version ASC
         */
        if (tenantId !== undefined) {
            values.push(this.tenantIdConversion?.toDatabase(tenantId) ?? tenantId);
            whereClauses.push(`tenant_id = $${values.length}`);
        }

        values.push(this.idConversion?.toDatabase(id) ?? id);
        whereClauses.push(`aggregate_root_id = $${values.length}`);

        if (after > 0) {
            values.push(after);
            whereClauses.push(`version > $${values.length}`);
        }

        if (before > 0) {
            values.push(before);
            whereClauses.push(`version < $${values.length}`);
        }

        const records = await connection.query<MessageRecord<Stream>>(`
            SELECT id, payload FROM ${this.tableName}
            WHERE ${whereClauses.join(' AND ')}
            ORDER BY version ASC`,
            values,
        );

        for (const r of records.rows) {
            const message = r.payload as unknown as AnyMessageFrom<Stream>;

            yield messageWithHeader(message, {
                key: 'stream_offset',
                value: r.id,
            });
        }
    }

    async persist(id: Stream['aggregateRootId'], messages: MessagesFrom<Stream>): Promise<void> {
        if (messages.length === 0) {
            return;
        }

        const values: any[] = [this.idConversion?.toDatabase(id) ?? id];
        const tenantId = this.tenantContext?.mustResolve();
        let tenantIdColumn = '';
        let globalReferences = '$1, ';
        let index: number = 1;
        const references: string[] = [];

        if (tenantId !== undefined) {
            tenantIdColumn = 'tenant_id, ';
            globalReferences = '$1, $2, ';
            index++;
            values.unshift(this.tenantIdConversion?.toDatabase(tenantId) ?? tenantId);
        }

        for (const message of messages) {
            references.push(`${globalReferences}$${++index}, $${++index}, $${++index}`);
            values.push(message.headers.aggregate_root_version ?? 0, message.type, message);
        }

        const {style, channelName = 'outbox_publish'} = this.notificationConfiguration;

        if (style === 'none') {
            const connection = await this.pool.primary();
            await connection.query(
                `INSERT INTO ${this.tableName} (
                    ${tenantIdColumn}aggregate_root_id, version, event_type, payload
                    ) VALUES (${references.join('), (')});`,
                values,
            );

            return;
        }

        const inTransaction = this.pool.inTransaction();
        const transaction = inTransaction ? this.pool.withTransaction() : await this.pool.begin();

        try {
            await transaction.query(
                `INSERT INTO ${this.tableName} (
                    ${tenantIdColumn}aggregate_root_id, version, event_type, payload
                    ) VALUES (${references.join('), (')});`,
                values,
            );

            if (style !== 'central') {
                await transaction.query(`NOTIFY ${channelName}__${this.tableName}`);
            }

            if (style !== 'channel') {
                await transaction.query(`NOTIFY ${channelName}, '${this.tableName}'`);
            }

            if (!inTransaction) {
                await this.pool.commit(transaction);
            }
        } catch (e) {
            if (!inTransaction) {
                await this.pool.rollback(transaction);
            }
            throw e;
        }
    }

    retrieveAllForAggregate(id: Stream['aggregateRootId']): AsyncGenerator<AnyMessageFrom<Stream>> {
        return this.retrieveBetweenVersions(id, 0, 0);
    }

    async *paginateIds(options: IdPaginationOptions<Stream>): AsyncGenerator<AggregateIdWithStreamOffset<Stream>> {
        const {limit, afterId, whichMessage = 'last'} = options;
        const connection = await this.pool.primary();

        const values: any[] = [limit];
        let whereClause = '';

        if (afterId !== undefined) {
            values.unshift(this.idConversion?.toDatabase(afterId) ?? afterId);
            whereClause = 'WHERE aggregate_root_id > $1';
        }

        const {rows} = await connection.query<MessageRecord<Stream>>(
            `
            SELECT DISTINCT ON (aggregate_root_id) id, aggregate_root_id, payload, version FROM ${this.tableName} ${whereClause}
            ORDER BY aggregate_root_id, version ${whichMessage === 'last' ? 'DESC' : 'ASC'}
            LIMIT $${values.length}
        `,
            values,
        );

        for (const row of rows) {
            yield {
                id:
                    this.idConversion?.fromDatabase(row.aggregate_root_id) ??
                    (row.aggregate_root_id as Stream['aggregateRootId']),
                version: Number(row.version),
                message: messageWithHeader(row.payload, {
                    key: 'stream_offset',
                    value: row.id,
                }),
            };
        }
    }
}
