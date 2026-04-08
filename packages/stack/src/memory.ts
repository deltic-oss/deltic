import type {DependencyContainer} from '@deltic/dependency-injection';
import type {AggregateStreamWithSnapshotting, SnapshotRepository} from '@deltic/event-sourcing/snapshotting';
import {SnapshotRepositoryForTesting} from '@deltic/event-sourcing/snapshotting';
import type {MessageRepository, StreamDefinition} from '@deltic/messaging';
import type {OutboxRepository} from '@deltic/messaging/outbox';
import {OutboxRepositoryUsingMemory} from '@deltic/messaging/outbox';
import {MessageRepositoryUsingMemory} from '@deltic/messaging/message-repository-using-memory';
import {NoopTransactionManager, type TransactionManager} from '@deltic/transaction-manager';

import type {
    InfrastructureProvider,
    MessageRepositoryOptions,
    OutboxRepositoryOptions,
    SnapshotRepositoryOptions,
} from './infrastructure-provider.js';

/**
 * Infrastructure provider that creates in-memory repositories.
 *
 * This provider is useful for testing scenarios where you don't want to
 * depend on a real database. Note that the table name and version options
 * are accepted but ignored, since in-memory repositories don't use them.
 *
 * @example
 * ```typescript
 * const provider = new InfrastructureProviderUsingMemory();
 *
 * const services = setupEventSourcing(container, provider, {
 *     eventTable: 'order_events',    // Ignored for memory provider
 *     outboxTable: 'order_outbox',   // Ignored for memory provider
 *     factory: () => new OrderFactory(),
 * });
 * ```
 */
export class InfrastructureProviderUsingMemory implements InfrastructureProvider {
    createMessageRepository<Stream extends StreamDefinition>(
        container: DependencyContainer,
        options: MessageRepositoryOptions,
    ): MessageRepository<Stream> {
        return new MessageRepositoryUsingMemory<Stream>();
    }

    createOutboxRepository<Stream extends StreamDefinition>(
        container: DependencyContainer,
        options: OutboxRepositoryOptions,
    ): OutboxRepository<Stream> {
        return new OutboxRepositoryUsingMemory<Stream>();
    }

    createTransactionManager(container: DependencyContainer): TransactionManager {
        return new NoopTransactionManager();
    }

    createSnapshotRepository<Stream extends AggregateStreamWithSnapshotting<Stream>>(
        container: DependencyContainer,
        options: SnapshotRepositoryOptions,
    ): SnapshotRepository<Stream> {
        return new SnapshotRepositoryForTesting<Stream>();
    }
}
