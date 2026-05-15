import {Pool} from 'pg';
import * as uuid from 'uuid';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {ValueReadWriterUsingMemory} from '@deltic/context';
import {pgTestCredentials} from '../../../pg-credentials.js';
import type {AggregateStreamWithSnapshotting, Snapshot} from '../snapshotting.js';
import {SnapshotRepositoryUsingPg} from './snapshot-repository.js';

interface TestSnapshotStream extends AggregateStreamWithSnapshotting<TestSnapshotStream> {
    topic: 'testing';
    messages: {
        something_happened: {value: number};
    };
    aggregateRootId: string;
    aggregateRoot: any;
    snapshot: {counter: number; name: string};
}

const firstTenantId = uuid.v7();
const secondTenantId = uuid.v7();

describe('SnapshotRepositoryUsingPg', () => {
    let pgPool: Pool;
    let asyncPool: AsyncPgPool;

    beforeAll(async () => {
        pgPool = new Pool(pgTestCredentials);

        // Create table without tenant_id for basic tests
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS test__snapshots (
                aggregate_root_id UUID NOT NULL,
                version BIGINT NOT NULL,
                state JSONB NOT NULL,
                schema_version INTEGER NOT NULL,
                PRIMARY KEY (aggregate_root_id, schema_version)
            );
        `);

        // Create table with tenant_id for multi-tenant tests
        await pgPool.query(`
            CREATE TABLE IF NOT EXISTS test__snapshots_tenant (
                tenant_id UUID NOT NULL,
                aggregate_root_id UUID NOT NULL,
                version BIGINT NOT NULL,
                state JSONB NOT NULL,
                schema_version INTEGER NOT NULL,
                PRIMARY KEY (tenant_id, aggregate_root_id, schema_version)
            );
        `);
    });

    beforeEach(() => {
        asyncPool = new AsyncPgPool(pgPool);
    });

    afterAll(async () => {
        await pgPool.query('DROP TABLE IF EXISTS test__snapshots');
        await pgPool.query('DROP TABLE IF EXISTS test__snapshots_tenant');
        await asyncPool?.flush();
        await pgPool.end();
    });

    afterEach(async () => {
        await asyncPool.flush();
        await pgPool.query('TRUNCATE TABLE test__snapshots');
        await pgPool.query('TRUNCATE TABLE test__snapshots_tenant');
    });

    describe('basic operations (no tenant)', () => {
        let repository: SnapshotRepositoryUsingPg<TestSnapshotStream>;

        beforeEach(() => {
            repository = new SnapshotRepositoryUsingPg<TestSnapshotStream>(asyncPool, 'test__snapshots', 1);
        });

        test('store and retrieve a snapshot', async () => {
            const id = uuid.v7();
            const snapshot: Snapshot<TestSnapshotStream> = {
                aggregateRootId: id,
                version: 5,
                state: {counter: 42, name: 'test'},
            };

            await repository.store(snapshot);
            const retrieved = await repository.retrieve(id);

            expect(retrieved).toEqual(snapshot);
        });

        test('retrieve returns undefined when no snapshot exists', async () => {
            const id = uuid.v7();

            const retrieved = await repository.retrieve(id);

            expect(retrieved).toBeUndefined();
        });

        test('store updates existing snapshot (upsert)', async () => {
            const id = uuid.v7();
            const snapshot1: Snapshot<TestSnapshotStream> = {
                aggregateRootId: id,
                version: 5,
                state: {counter: 42, name: 'first'},
            };
            const snapshot2: Snapshot<TestSnapshotStream> = {
                aggregateRootId: id,
                version: 10,
                state: {counter: 100, name: 'updated'},
            };

            await repository.store(snapshot1);
            await repository.store(snapshot2);
            const retrieved = await repository.retrieve(id);

            expect(retrieved).toEqual(snapshot2);
        });

        test('clear removes snapshots for the schema version', async () => {
            const id1 = uuid.v7();
            const id2 = uuid.v7();

            await repository.store({aggregateRootId: id1, version: 1, state: {counter: 1, name: 'a'}});
            await repository.store({aggregateRootId: id2, version: 2, state: {counter: 2, name: 'b'}});

            await repository.clear();

            expect(await repository.retrieve(id1)).toBeUndefined();
            expect(await repository.retrieve(id2)).toBeUndefined();
        });
    });

    describe('schema version isolation', () => {
        test('retrieve only returns snapshots matching schema version', async () => {
            const id = uuid.v7();
            const repoV1 = new SnapshotRepositoryUsingPg<TestSnapshotStream>(asyncPool, 'test__snapshots', 1);
            const repoV2 = new SnapshotRepositoryUsingPg<TestSnapshotStream>(asyncPool, 'test__snapshots', 2);

            await repoV1.store({aggregateRootId: id, version: 5, state: {counter: 42, name: 'v1'}});

            const retrievedV1 = await repoV1.retrieve(id);
            const retrievedV2 = await repoV2.retrieve(id);

            expect(retrievedV1?.state.name).toBe('v1');
            expect(retrievedV2).toBeUndefined();
        });

        test('different schema versions can have separate snapshots', async () => {
            const id = uuid.v7();
            const repoV1 = new SnapshotRepositoryUsingPg<TestSnapshotStream>(asyncPool, 'test__snapshots', 1);
            const repoV2 = new SnapshotRepositoryUsingPg<TestSnapshotStream>(asyncPool, 'test__snapshots', 2);

            await repoV1.store({aggregateRootId: id, version: 5, state: {counter: 42, name: 'v1'}});
            await repoV2.store({aggregateRootId: id, version: 10, state: {counter: 100, name: 'v2'}});

            const retrievedV1 = await repoV1.retrieve(id);
            const retrievedV2 = await repoV2.retrieve(id);

            expect(retrievedV1?.version).toBe(5);
            expect(retrievedV1?.state.name).toBe('v1');
            expect(retrievedV2?.version).toBe(10);
            expect(retrievedV2?.state.name).toBe('v2');
        });

        test('clear only removes snapshots for the schema version', async () => {
            const id = uuid.v7();
            const repoV1 = new SnapshotRepositoryUsingPg<TestSnapshotStream>(asyncPool, 'test__snapshots', 1);
            const repoV2 = new SnapshotRepositoryUsingPg<TestSnapshotStream>(asyncPool, 'test__snapshots', 2);

            await repoV1.store({aggregateRootId: id, version: 5, state: {counter: 42, name: 'v1'}});
            await repoV2.store({aggregateRootId: id, version: 10, state: {counter: 100, name: 'v2'}});

            await repoV1.clear();

            expect(await repoV1.retrieve(id)).toBeUndefined();
            expect(await repoV2.retrieve(id)).not.toBeUndefined();
        });
    });

    describe('multi-tenant operations', () => {
        let tenantContext: ValueReadWriterUsingMemory<string>;
        let repository: SnapshotRepositoryUsingPg<TestSnapshotStream>;

        beforeEach(() => {
            tenantContext = new ValueReadWriterUsingMemory<string>(firstTenantId);
            repository = new SnapshotRepositoryUsingPg<TestSnapshotStream>(
                asyncPool,
                'test__snapshots_tenant',
                1,
                {tenantContext},
            );
        });

        test('store and retrieve with tenant isolation', async () => {
            const id = uuid.v7();

            // Store as first tenant
            tenantContext.use(firstTenantId);
            await repository.store({aggregateRootId: id, version: 5, state: {counter: 42, name: 'tenant1'}});

            // Store as second tenant (same aggregate ID)
            tenantContext.use(secondTenantId);
            await repository.store({aggregateRootId: id, version: 10, state: {counter: 100, name: 'tenant2'}});

            // Retrieve as first tenant
            tenantContext.use(firstTenantId);
            const retrieved1 = await repository.retrieve(id);
            expect(retrieved1?.state.name).toBe('tenant1');
            expect(retrieved1?.version).toBe(5);

            // Retrieve as second tenant
            tenantContext.use(secondTenantId);
            const retrieved2 = await repository.retrieve(id);
            expect(retrieved2?.state.name).toBe('tenant2');
            expect(retrieved2?.version).toBe(10);
        });

        test('clear only removes snapshots for current tenant and schema version', async () => {
            const id = uuid.v7();

            // Store as first tenant
            tenantContext.use(firstTenantId);
            await repository.store({aggregateRootId: id, version: 5, state: {counter: 42, name: 'tenant1'}});

            // Store as second tenant
            tenantContext.use(secondTenantId);
            await repository.store({aggregateRootId: id, version: 10, state: {counter: 100, name: 'tenant2'}});

            // Clear as first tenant
            tenantContext.use(firstTenantId);
            await repository.clear();

            // First tenant's snapshot should be gone
            expect(await repository.retrieve(id)).toBeUndefined();

            // Second tenant's snapshot should still exist
            tenantContext.use(secondTenantId);
            expect(await repository.retrieve(id)).not.toBeUndefined();
        });

        test('retrieve returns undefined for different tenant', async () => {
            const id = uuid.v7();

            // Store as first tenant
            tenantContext.use(firstTenantId);
            await repository.store({aggregateRootId: id, version: 5, state: {counter: 42, name: 'tenant1'}});

            // Try to retrieve as second tenant
            tenantContext.use(secondTenantId);
            const retrieved = await repository.retrieve(id);

            expect(retrieved).toBeUndefined();
        });
    });

    describe('complex state serialization', () => {
        let repository: SnapshotRepositoryUsingPg<TestSnapshotStream>;

        beforeEach(() => {
            repository = new SnapshotRepositoryUsingPg<TestSnapshotStream>(asyncPool, 'test__snapshots', 1);
        });

        test('handles nested objects in state', async () => {
            const id = uuid.v7();

            // Using any to test more complex state structures
            const complexState = {
                counter: 42,
                name: 'test',
                nested: {
                    deep: {
                        value: 'nested value',
                    },
                },
                array: [1, 2, 3],
            };

            await repository.store({
                aggregateRootId: id,
                version: 5,
                state: complexState as any,
            });

            const retrieved = await repository.retrieve(id);
            expect(retrieved?.state).toEqual(complexState);
        });

        test('handles null values in state', async () => {
            const id = uuid.v7();

            const stateWithNull = {
                counter: 0,
                name: null as any,
            };

            await repository.store({
                aggregateRootId: id,
                version: 1,
                state: stateWithNull as any,
            });

            const retrieved = await repository.retrieve(id);
            expect(retrieved?.state).toEqual(stateWithNull);
        });
    });
});
