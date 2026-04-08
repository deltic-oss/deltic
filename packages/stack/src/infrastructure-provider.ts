import type {DependencyContainer} from '@deltic/dependency-injection';
import type {AggregateStreamWithSnapshotting, SnapshotRepository} from '@deltic/event-sourcing/snapshotting';
import type {MessageRepository, StreamDefinition} from '@deltic/messaging';
import type {OutboxRepository} from '@deltic/messaging/outbox';
import type {TransactionManager} from '@deltic/transaction-manager';

export interface MessageRepositoryOptions {
    tableName: string;
}

export interface OutboxRepositoryOptions {
    tableName: string;
}

export interface SnapshotRepositoryOptions {
    tableName: string;
    version: number;
}

export interface InfrastructureProvider {
    createMessageRepository<Stream extends StreamDefinition>(
        container: DependencyContainer,
        options: MessageRepositoryOptions,
    ): MessageRepository<Stream>;

    createOutboxRepository<Stream extends StreamDefinition>(
        container: DependencyContainer,
        options: OutboxRepositoryOptions,
    ): OutboxRepository<Stream>;

    createTransactionManager(container: DependencyContainer): TransactionManager;

    createSnapshotRepository<Stream extends AggregateStreamWithSnapshotting<Stream>>(
        container: DependencyContainer,
        options: SnapshotRepositoryOptions,
    ): SnapshotRepository<Stream>;
}
