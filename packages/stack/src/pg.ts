import type {ServiceKey} from '@deltic/dependency-injection';
import type {DependencyContainer} from '@deltic/dependency-injection';
import {AsyncPgPool, TransactionManagerUsingPg} from '@deltic/async-pg-pool';
import type {AggregateStreamWithSnapshotting, SnapshotRepository} from '@deltic/event-sourcing/snapshotting';
import {
    SnapshotRepositoryUsingPg,
    type SnapshotRepositoryUsingPgOptions,
} from '@deltic/event-sourcing/pg/snapshot-repository';
import type {MessageRepository, StreamDefinition} from '@deltic/messaging';
import type {OutboxRepository} from '@deltic/messaging/outbox';
import {MessageRepositoryUsingPg, type MessageRepositoryUsingPgOptions} from '@deltic/messaging/pg/message-repository';
import {OutboxRepositoryUsingPg, type OutboxNotifyConfiguration} from '@deltic/messaging/pg/outbox-repository';
import type {TransactionManager} from '@deltic/transaction-manager';

import type {
    InfrastructureProvider,
    MessageRepositoryOptions,
    OutboxRepositoryOptions,
    SnapshotRepositoryOptions,
} from './infrastructure-provider.js';

/**
 * Options for configuring the PostgreSQL infrastructure provider.
 */
export interface PostgresProviderOptions<Stream extends StreamDefinition = StreamDefinition> {
    /**
     * Service key for resolving the AsyncPgPool from the container.
     */
    pool: ServiceKey<AsyncPgPool>;

    /**
     * Optional configuration for the message repository.
     * Allows customizing ID conversion, tenant context, notifications, etc.
     */
    messageRepositoryOptions?: Partial<MessageRepositoryUsingPgOptions<Stream>>;

    /**
     * Optional configuration for the snapshot repository.
     * Allows customizing ID conversion, tenant context, etc.
     */
    snapshotRepositoryOptions?: Partial<SnapshotRepositoryUsingPgOptions<Stream & AggregateStreamWithSnapshotting<any>>>;

    /**
     * How the outbox repository announces new messages, which lets an outbox relay react instead of
     * waiting for its poll interval. Defaults to `{style: 'both'}`: every outbox write sends
     * `NOTIFY outbox_publish__<outboxTable>`, the channel `setupOutboxRelay` listens on, and
     * `NOTIFY outbox_publish, '<outboxTable>'`, the channel and payload `setupMultiOutboxRelay`
     * listens for. Both are delivered on commit only. `{style: 'none'}` relies on polling alone.
     */
    outboxNotification?: OutboxNotifyConfiguration;
}

/**
 * Infrastructure provider that creates PostgreSQL-backed repositories.
 *
 * @example
 * ```typescript
 * const poolKey = container.register('pg:pool', {
 *     factory: () => new AsyncPgPool(pool),
 * });
 *
 * const provider = new InfrastructureProviderUsingPostgres({ pool: poolKey });
 *
 * const services = setupEventSourcing(container, provider, {
 *     eventTable: 'order_events',
 *     outboxTable: 'order_outbox',
 *     factory: () => new OrderFactory(),
 * });
 * ```
 */
export class InfrastructureProviderUsingPostgres<Stream extends StreamDefinition = StreamDefinition>
    implements InfrastructureProvider
{
    constructor(private readonly options: PostgresProviderOptions<Stream>) {}

    createMessageRepository<S extends StreamDefinition>(
        container: DependencyContainer,
        options: MessageRepositoryOptions,
    ): MessageRepository<S> {
        const pool = container.resolve(this.options.pool);

        return new MessageRepositoryUsingPg<S>(
            pool,
            options.tableName,
            this.options.messageRepositoryOptions as MessageRepositoryUsingPgOptions<S>,
        );
    }

    createOutboxRepository<S extends StreamDefinition>(
        container: DependencyContainer,
        options: OutboxRepositoryOptions,
    ): OutboxRepository<S> {
        const pool = container.resolve(this.options.pool);

        return new OutboxRepositoryUsingPg<S>(
            pool,
            options.tableName,
            this.options.outboxNotification ?? {style: 'both'},
        );
    }

    createTransactionManager(container: DependencyContainer): TransactionManager {
        const pool = container.resolve(this.options.pool);

        return new TransactionManagerUsingPg(pool);
    }

    createSnapshotRepository<S extends AggregateStreamWithSnapshotting<S>>(
        container: DependencyContainer,
        options: SnapshotRepositoryOptions,
    ): SnapshotRepository<S> {
        const pool = container.resolve(this.options.pool);

        return new SnapshotRepositoryUsingPg<S>(
            pool,
            options.tableName,
            options.version,
            this.options.snapshotRepositoryOptions as SnapshotRepositoryUsingPgOptions<S>,
        );
    }
}
