import {Pool} from 'pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {DependencyContainer, type ServiceKey} from '@deltic/dependency-injection';
import {messageFactory} from '@deltic/messaging/helpers';
import {CollectingMessageConsumer} from '@deltic/messaging/collecting-message-consumer';
import {pgTestCredentials} from '../../pg-credentials.js';

import {setupEventSourcing} from './event-sourcing.js';
import {InfrastructureProviderUsingMemory} from './memory.js';
import {InfrastructureProviderUsingPostgres} from './pg.js';
import type {InfrastructureProvider} from './infrastructure-provider.js';
import type {EventSourcingConfig, EventSourcingServices, SnapshotConfig} from './event-sourcing.js';
import type {TestSnapshotStream, TestStream} from './test-stream.stubs.js';
import {TestAggregateRootFactory, TestSnapshottedAggregateRootFactory} from './test-stream.stubs.js';

function uniqueProviderKey(): string {
    return `test:provider:${Date.now()}:${Math.random()}`;
}

// ============ Provider Setup Types ============

export interface ProviderTestSetup {
    name: string;
    createProvider(container: DependencyContainer): InfrastructureProvider;
    beforeAllFn?(): Promise<void>;
    afterAllFn?(): Promise<void>;
    afterEachFn?(): Promise<void>;
}

// ============ Shared PostgreSQL State ============

let pgPool: Pool | undefined;
let asyncPool: AsyncPgPool | undefined;

// ============ Provider Configurations ============

export const providerSetups: ProviderTestSetup[] = [
    {
        name: 'Memory',
        createProvider: () => new InfrastructureProviderUsingMemory(),
    },
    {
        name: 'PostgreSQL',
        createProvider: container => {
            asyncPool = new AsyncPgPool(pgPool!);
            const poolKey = container.register('pg:pool', {factory: () => asyncPool!});
            return new InfrastructureProviderUsingPostgres({pool: poolKey});
        },
        beforeAllFn: async () => {
            pgPool = new Pool(pgTestCredentials);
            await pgPool.query(`
                CREATE TABLE IF NOT EXISTS test_stack_events (
                    id BIGSERIAL PRIMARY KEY,
                    tenant_id UUID,
                    aggregate_root_id VARCHAR(255) NOT NULL,
                    version SMALLINT NOT NULL,
                    event_type VARCHAR(255) NOT NULL,
                    payload JSONB NOT NULL
                );
            `);
            await pgPool.query(`
                CREATE TABLE IF NOT EXISTS test_stack_outbox (
                    id BIGSERIAL PRIMARY KEY,
                    consumed BOOLEAN NOT NULL DEFAULT FALSE,
                    payload JSONB NOT NULL
                );
            `);
            await pgPool.query(`
                CREATE TABLE IF NOT EXISTS test_stack_snapshots (
                    aggregate_root_id UUID NOT NULL,
                    version BIGINT NOT NULL,
                    state JSONB NOT NULL,
                    schema_version INTEGER NOT NULL,
                    PRIMARY KEY (aggregate_root_id, schema_version)
                );
            `);
        },
        afterAllFn: async () => {
            await pgPool?.end();
            pgPool = undefined;
        },
        afterEachFn: async () => {
            await asyncPool?.flushSharedContext();
            await pgPool?.query('TRUNCATE TABLE test_stack_events RESTART IDENTITY');
            await pgPool?.query('TRUNCATE TABLE test_stack_outbox RESTART IDENTITY');
            await pgPool?.query('TRUNCATE TABLE test_stack_snapshots');
        },
    },
];

// ============ Test Context Factory ============

export interface TestContext {
    container: DependencyContainer;
    provider: InfrastructureProvider;
    services: EventSourcingServices<TestStream>;
    collector: CollectingMessageConsumer<TestStream>;
    collectorKey: ServiceKey<CollectingMessageConsumer<TestStream>>;
    createMessage: ReturnType<typeof messageFactory<TestStream>>;
}

export function createTestContext(
    provider: InfrastructureProvider,
    container: DependencyContainer,
    configOverrides: Partial<EventSourcingConfig<TestStream>> = {},
): TestContext {
    const collector = new CollectingMessageConsumer<TestStream>();

    const providerKey = container.register(uniqueProviderKey(), {
        factory: () => provider,
    });

    const collectorKey = container.register('test:collector', {
        factory: () => collector,
    });

    const services = setupEventSourcing<TestStream>(container, providerKey, {
        eventTable: 'test_stack_events',
        outboxTable: 'test_stack_outbox',
        factory: () => new TestAggregateRootFactory(),
        synchronousConsumers: [collectorKey],
        ...configOverrides,
    });

    return {
        container,
        provider,
        services,
        collector,
        collectorKey,
        createMessage: messageFactory<TestStream>(),
    };
}

// ============ Snapshot Test Context Factory ============

export interface SnapshotTestContext {
    container: DependencyContainer;
    provider: InfrastructureProvider;
    services: EventSourcingServices<TestSnapshotStream>;
    collector: CollectingMessageConsumer<TestSnapshotStream>;
    collectorKey: ServiceKey<CollectingMessageConsumer<TestSnapshotStream>>;
    createMessage: ReturnType<typeof messageFactory<TestSnapshotStream>>;
}

export function createSnapshotTestContext(
    provider: InfrastructureProvider,
    container: DependencyContainer,
    snapshotConfig: Omit<SnapshotConfig<TestSnapshotStream>, 'factory'> & {
        authoritativeSnapshots?: boolean;
    },
): SnapshotTestContext {
    const collector = new CollectingMessageConsumer<TestSnapshotStream>();

    const collectorKey = container.register('test:snapshot-collector', {
        factory: () => collector,
    });

    const providerKey = container.register(uniqueProviderKey(), {
        factory: () => provider,
    });

    const services = setupEventSourcing<TestSnapshotStream>(container, providerKey, {
        eventTable: 'test_stack_events',
        outboxTable: 'test_stack_outbox',
        factory: () => new TestSnapshottedAggregateRootFactory(),
        synchronousConsumers: [collectorKey],
        snapshotting: {
            snapshotTable: snapshotConfig.snapshotTable,
            snapshotVersion: snapshotConfig.snapshotVersion,
            authoritativeSnapshots: snapshotConfig.authoritativeSnapshots,
            factory: () => new TestSnapshottedAggregateRootFactory(),
        },
    });

    return {
        container,
        provider,
        services,
        collector,
        collectorKey,
        createMessage: messageFactory<TestSnapshotStream>(),
    };
}

// ============ Utility Functions ============

export async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of gen) {
        items.push(item);
    }
    return items;
}
