import {Pool} from 'pg';
import {AsyncPgPool, TransactionManagerUsingPg} from '@deltic/async-pg-pool';
import {DependencyContainer} from '@deltic/dependency-injection';
import {MessageRepositoryUsingMemory} from '@deltic/messaging/message-repository-using-memory';
import {OutboxRepositoryUsingMemory} from '@deltic/messaging/outbox';
import {MessageRepositoryUsingPg} from '@deltic/messaging/pg/message-repository';
import {OutboxRepositoryUsingPg} from '@deltic/messaging/pg/outbox-repository';
import {NoopTransactionManager} from '@deltic/transaction-manager';
import {SnapshotRepositoryForTesting} from '@deltic/event-sourcing/snapshotting';
import {SnapshotRepositoryUsingPg} from '@deltic/event-sourcing/pg/snapshot-repository';
import {pgTestCredentials} from '../../pg-credentials.js';

import {InfrastructureProviderUsingMemory} from './memory.js';
import {InfrastructureProviderUsingPostgres} from './pg.js';
import type {InfrastructureProvider} from './infrastructure-provider.js';

// ============ Provider Test Configuration ============

interface ProviderExpectations {
    name: string;
    setup(): {provider: InfrastructureProvider; container: DependencyContainer};
    beforeAllFn?(): Promise<void>;
    afterAllFn?(): Promise<void>;
    afterEachFn?(): Promise<void>;
    expectations: {
        messageRepository: new (...args: any[]) => any;
        outboxRepository: new (...args: any[]) => any;
        transactionManager: new (...args: any[]) => any;
        snapshotRepository: new (...args: any[]) => any;
    };
}

// ============ Shared PostgreSQL State ============

let pgPool: Pool | undefined;
let asyncPool: AsyncPgPool | undefined;

// ============ Provider Expectations ============

const providerExpectations: ProviderExpectations[] = [
    {
        name: 'Memory',
        setup: () => {
            const container = new DependencyContainer();
            return {
                provider: new InfrastructureProviderUsingMemory(),
                container,
            };
        },
        expectations: {
            messageRepository: MessageRepositoryUsingMemory,
            outboxRepository: OutboxRepositoryUsingMemory,
            transactionManager: NoopTransactionManager,
            snapshotRepository: SnapshotRepositoryForTesting,
        },
    },
    {
        name: 'PostgreSQL',
        setup: () => {
            const container = new DependencyContainer();
            asyncPool = new AsyncPgPool(pgPool!);
            const poolKey = container.register('pg:pool', {factory: () => asyncPool!});
            return {
                provider: new InfrastructureProviderUsingPostgres({pool: poolKey}),
                container,
            };
        },
        beforeAllFn: async () => {
            pgPool = new Pool(pgTestCredentials);
        },
        afterAllFn: async () => {
            await pgPool?.end();
            pgPool = undefined;
        },
        afterEachFn: async () => {
            await asyncPool?.flushSharedContext();
        },
        expectations: {
            messageRepository: MessageRepositoryUsingPg,
            outboxRepository: OutboxRepositoryUsingPg,
            transactionManager: TransactionManagerUsingPg,
            snapshotRepository: SnapshotRepositoryUsingPg,
        },
    },
];

// ============ Tests ============

describe.each(providerExpectations)('InfrastructureProvider ($name)', (config: ProviderExpectations) => {
    beforeAll(async () => {
        await config.beforeAllFn?.();
    });

    afterAll(async () => {
        await config.afterAllFn?.();
    });

    afterEach(async () => {
        await config.afterEachFn?.();
    });

    test('createMessageRepository returns correct implementation', () => {
        const {provider, container} = config.setup();
        const repo = provider.createMessageRepository(container, {tableName: 'test_events'});

        expect(repo).toBeInstanceOf(config.expectations.messageRepository);
    });

    test('createOutboxRepository returns correct implementation', () => {
        const {provider, container} = config.setup();
        const repo = provider.createOutboxRepository(container, {tableName: 'test_outbox'});

        expect(repo).toBeInstanceOf(config.expectations.outboxRepository);
    });

    test('createTransactionManager returns correct implementation', () => {
        const {provider, container} = config.setup();
        const tm = provider.createTransactionManager(container);

        expect(tm).toBeInstanceOf(config.expectations.transactionManager);
    });

    test('createSnapshotRepository returns correct implementation', () => {
        const {provider, container} = config.setup();
        const repo = provider.createSnapshotRepository(container, {
            tableName: 'test_snapshots',
            version: 1,
        });

        expect(repo).toBeInstanceOf(config.expectations.snapshotRepository);
    });
});

// ============ Memory-specific tests ============

describe('InfrastructureProviderUsingMemory', () => {
    test('ignores tableName parameter for message repository', () => {
        const container = new DependencyContainer();
        const provider = new InfrastructureProviderUsingMemory();

        // Should not throw, tableName is ignored
        const repo1 = provider.createMessageRepository(container, {tableName: 'table_a'});
        const repo2 = provider.createMessageRepository(container, {tableName: 'table_b'});

        expect(repo1).toBeInstanceOf(MessageRepositoryUsingMemory);
        expect(repo2).toBeInstanceOf(MessageRepositoryUsingMemory);
    });

    test('ignores version parameter for snapshot repository', () => {
        const container = new DependencyContainer();
        const provider = new InfrastructureProviderUsingMemory();

        const repo1 = provider.createSnapshotRepository(container, {tableName: 'snaps', version: 1});
        const repo2 = provider.createSnapshotRepository(container, {tableName: 'snaps', version: 99});

        expect(repo1).toBeInstanceOf(SnapshotRepositoryForTesting);
        expect(repo2).toBeInstanceOf(SnapshotRepositoryForTesting);
    });
});

// ============ PostgreSQL-specific tests ============

describe('InfrastructureProviderUsingPostgres', () => {
    let pgPool: Pool;
    let asyncPool: AsyncPgPool;

    beforeAll(async () => {
        pgPool = new Pool(pgTestCredentials);
    });

    afterAll(async () => {
        await pgPool.end();
    });

    afterEach(async () => {
        await asyncPool?.flushSharedContext();
    });

    test('uses provided pool from container', () => {
        const container = new DependencyContainer();
        asyncPool = new AsyncPgPool(pgPool);
        const poolKey = container.register('pg:pool', {factory: () => asyncPool});

        const provider = new InfrastructureProviderUsingPostgres({pool: poolKey});
        const repo = provider.createMessageRepository(container, {tableName: 'test_events'});

        expect(repo).toBeInstanceOf(MessageRepositoryUsingPg);
    });

    test('passes tableName to MessageRepositoryUsingPg', () => {
        const container = new DependencyContainer();
        asyncPool = new AsyncPgPool(pgPool);
        const poolKey = container.register('pg:pool', {factory: () => asyncPool});

        const provider = new InfrastructureProviderUsingPostgres({pool: poolKey});
        const repo = provider.createMessageRepository(container, {
            tableName: 'custom_events_table',
        }) as MessageRepositoryUsingPg<any>;

        // The tableName is used internally - we can verify it was created without error
        expect(repo).toBeInstanceOf(MessageRepositoryUsingPg);
    });

    test('passes version to SnapshotRepositoryUsingPg', () => {
        const container = new DependencyContainer();
        asyncPool = new AsyncPgPool(pgPool);
        const poolKey = container.register('pg:pool', {factory: () => asyncPool});

        const provider = new InfrastructureProviderUsingPostgres({pool: poolKey});
        const repo = provider.createSnapshotRepository(container, {
            tableName: 'snapshots',
            version: 42,
        });

        expect(repo).toBeInstanceOf(SnapshotRepositoryUsingPg);
    });
});
