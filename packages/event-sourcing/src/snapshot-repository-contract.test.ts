import {Pool} from 'pg';
import * as uuid from 'uuid';
import {AsyncPgPool, TransactionManagerUsingPg} from '@deltic/async-pg-pool';
import {ValueReadWriterUsingMemory} from '@deltic/context';
import {MessageRepositoryUsingPg} from '@deltic/messaging/pg/message-repository';
import {NoIdConversion, PrefixedBrandedIdConversion} from '@deltic/uid';
import {pgTestCredentials} from '../../pg-credentials.js';
import {Order, type OrderStream} from './order.stubs.js';
import {SnapshotRepositoryUsingPg} from './pg/snapshot-repository.js';
import {
    AggregateRootRepositoryWithSnapshotting,
    SnapshotRepositoryForTesting,
    type AggregateRootWithSnapshotting,
    type AggregateStreamWithSnapshotting,
    type SnapshotRepository,
    type SnapshotType,
} from './snapshotting.js';

interface SnapshotStateForTesting {
    [key: string]: SnapshotType;
}

interface ContractStream extends AggregateStreamWithSnapshotting<ContractStream> {
    aggregateRootId: string;
    aggregateRoot: AggregateRootWithSnapshotting<ContractStream>;
    messages: {something_happened: {value: number}};
    snapshot: SnapshotStateForTesting;
}

const snapshotTable = 'test__es_snapshots_contract';
const tenantSnapshotTable = 'test__es_snapshots_contract_tenant';
const eventsTable = 'test__es_snapshots_contract_events';

const firstTenantId = uuid.v7();
const secondTenantId = uuid.v7();

let pgPool: Pool;

beforeAll(async () => {
    pgPool = new Pool(pgTestCredentials);

    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS ${snapshotTable} (
            aggregate_root_id UUID NOT NULL,
            version BIGINT NOT NULL,
            state JSONB NOT NULL,
            schema_version INTEGER NOT NULL,
            PRIMARY KEY (aggregate_root_id, schema_version)
        );
    `);
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS ${tenantSnapshotTable} (
            tenant_id UUID NOT NULL,
            aggregate_root_id UUID NOT NULL,
            version BIGINT NOT NULL,
            state JSONB NOT NULL,
            schema_version INTEGER NOT NULL,
            PRIMARY KEY (tenant_id, aggregate_root_id, schema_version)
        );
    `);
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS ${eventsTable} (
            id BIGSERIAL PRIMARY KEY,
            aggregate_root_id UUID NOT NULL,
            version BIGINT NOT NULL,
            event_type VARCHAR(255) NOT NULL,
            payload JSONB NOT NULL,
            UNIQUE (aggregate_root_id, version)
        );
    `);
});

afterAll(async () => {
    await pgPool.query(`DROP TABLE IF EXISTS ${snapshotTable}`);
    await pgPool.query(`DROP TABLE IF EXISTS ${tenantSnapshotTable}`);
    await pgPool.query(`DROP TABLE IF EXISTS ${eventsTable}`);
    await pgPool.end();
});

interface SnapshotRepositoryUnderTest {
    create(): SnapshotRepository<ContractStream>;
    cleanup(): Promise<void>;
}

const inMemorySnapshots = (): SnapshotRepositoryUnderTest => {
    let repository: SnapshotRepositoryForTesting<ContractStream> | undefined;

    return {
        create: () => (repository = new SnapshotRepositoryForTesting<ContractStream>()),
        cleanup: async () => {
            await repository?.clear();
            repository = undefined;
        },
    };
};

const postgresSnapshots = (tenantId: string | undefined = undefined): SnapshotRepositoryUnderTest => {
    let asyncPool: AsyncPgPool | undefined;
    const table = tenantId === undefined ? snapshotTable : tenantSnapshotTable;

    return {
        create: () => {
            asyncPool = new AsyncPgPool(pgPool);

            return new SnapshotRepositoryUsingPg<ContractStream>(asyncPool, table, 1, {
                tenantContext: tenantId === undefined ? undefined : new ValueReadWriterUsingMemory(tenantId),
            });
        },
        cleanup: async () => {
            await asyncPool?.flush();
            asyncPool = undefined;
            await pgPool.query(`TRUNCATE TABLE ${table}`);
        },
    };
};

describe.each([
    ['SnapshotRepositoryForTesting', inMemorySnapshots()],
    ['SnapshotRepositoryUsingPg', postgresSnapshots()],
    ['SnapshotRepositoryUsingPg scoped to a tenant', postgresSnapshots(firstTenantId)],
])('%s', (_name, implementation) => {
    let snapshots: SnapshotRepository<ContractStream>;
    let aggregateRootId: string;

    beforeEach(() => {
        aggregateRootId = uuid.v7();
        snapshots = implementation.create();
    });

    afterEach(async () => {
        await implementation.cleanup();
    });

    test('stores a snapshot and hands it back', async () => {
        const snapshot = {aggregateRootId, version: 5, state: {counter: 42, label: 'the answer'}};

        await snapshots.store(snapshot);

        expect(await snapshots.retrieve(aggregateRootId)).toEqual(snapshot);
    });

    test('hands back nothing for an aggregate that has no snapshot', async () => {
        expect(await snapshots.retrieve(uuid.v7())).toBeUndefined();
    });

    test('replaces the snapshot of an aggregate that already had one', async () => {
        await snapshots.store({aggregateRootId, version: 5, state: {counter: 42}});
        await snapshots.store({aggregateRootId, version: 11, state: {counter: 100}});

        expect(await snapshots.retrieve(aggregateRootId)).toEqual({
            aggregateRootId,
            version: 11,
            state: {counter: 100},
        });
    });

    test('keeps the snapshots of separate aggregates apart', async () => {
        const otherAggregateRootId = uuid.v7();
        await snapshots.store({aggregateRootId, version: 1, state: {counter: 1}});
        await snapshots.store({aggregateRootId: otherAggregateRootId, version: 2, state: {counter: 2}});

        expect(await snapshots.retrieve(aggregateRootId)).toEqual({
            aggregateRootId,
            version: 1,
            state: {counter: 1},
        });
        expect(await snapshots.retrieve(otherAggregateRootId)).toEqual({
            aggregateRootId: otherAggregateRootId,
            version: 2,
            state: {counter: 2},
        });
    });

    test('forgets every snapshot it can see when it is cleared', async () => {
        const otherAggregateRootId = uuid.v7();
        await snapshots.store({aggregateRootId, version: 1, state: {counter: 1}});
        await snapshots.store({aggregateRootId: otherAggregateRootId, version: 2, state: {counter: 2}});

        await snapshots.clear();

        expect(await snapshots.retrieve(aggregateRootId)).toBeUndefined();
        expect(await snapshots.retrieve(otherAggregateRootId)).toBeUndefined();
    });

    test('round-trips nested objects, unicode, null and empty collections', async () => {
        const state: SnapshotStateForTesting = {
            nested: {deep: {values: [1, 2, {flag: true}]}},
            unicode: 'Frank de Jonge 🎉 日本',
            nothing: null,
            emptyObject: {},
            emptyList: [],
            zero: 0,
            negative: -1,
            flag: false,
        };

        await snapshots.store({aggregateRootId, version: 1, state});

        expect((await snapshots.retrieve(aggregateRootId))?.state).toEqual(state);
    });

    test('round-trips a large version number', async () => {
        await snapshots.store({aggregateRootId, version: Number.MAX_SAFE_INTEGER, state: {counter: 1}});

        expect((await snapshots.retrieve(aggregateRootId))?.version).toEqual(Number.MAX_SAFE_INTEGER);
    });

    test('does not pollute the object prototype when the state carries a proto key', async () => {
        const state = JSON.parse('{"__proto__": {"polluted": "yes"}, "counter": 1}') as SnapshotStateForTesting;

        await snapshots.store({aggregateRootId, version: 1, state});
        const retrieved = await snapshots.retrieve(aggregateRootId);

        expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
        expect(Object.getPrototypeOf(retrieved?.state)).toBe(Object.prototype);
        expect(retrieved?.state['counter']).toEqual(1);
    });

    test('refuses state that cannot be represented as JSON', async () => {
        const state = {amountInCents: 10n} as unknown as SnapshotStateForTesting;

        await expect(snapshots.store({aggregateRootId, version: 1, state})).rejects.toThrow(/BigInt/);
    });
});

describe('the testing snapshot repository compared to the Postgres one', () => {
    const scheduledFor = new Date('2026-08-04T10:00:00.000Z');
    let asyncPool: AsyncPgPool;
    let aggregateRootId: string;

    beforeEach(() => {
        aggregateRootId = uuid.v7();
        asyncPool = new AsyncPgPool(pgPool);
    });

    afterEach(async () => {
        await asyncPool.flush();
        await pgPool.query(`TRUNCATE TABLE ${snapshotTable}`);
    });

    test('the testing repository rejects state that would not survive a round trip', async () => {
        const snapshots = new SnapshotRepositoryForTesting<ContractStream>();

        await expect(
            snapshots.store({aggregateRootId, version: 1, state: {scheduledFor} as SnapshotStateForTesting}),
        ).rejects.toThrow();
    });

    test('the Postgres repository turns a date in the state into a string', async () => {
        const snapshots = new SnapshotRepositoryUsingPg<ContractStream>(asyncPool, snapshotTable, 1);

        await snapshots.store({aggregateRootId, version: 1, state: {scheduledFor} as SnapshotStateForTesting});

        expect((await snapshots.retrieve(aggregateRootId))?.state).toEqual({
            scheduledFor: scheduledFor.toISOString(),
        });
    });
});

describe('SnapshotRepositoryUsingPg with identifier conversion', () => {
    const idConversion = new PrefixedBrandedIdConversion('ord', new NoIdConversion<string>());
    let asyncPool: AsyncPgPool;

    beforeEach(() => {
        asyncPool = new AsyncPgPool(pgPool);
    });

    afterEach(async () => {
        await asyncPool.flush();
        await pgPool.query(`TRUNCATE TABLE ${snapshotTable}`);
        await pgPool.query(`TRUNCATE TABLE ${tenantSnapshotTable}`);
    });

    test('stores the converted identifier and hands back the original one', async () => {
        const databaseId = uuid.v7();
        const aggregateRootId = `ord_${databaseId}`;
        const snapshots = new SnapshotRepositoryUsingPg<ContractStream>(asyncPool, snapshotTable, 1, {idConversion});

        await snapshots.store({aggregateRootId, version: 3, state: {counter: 1}});

        const {rows} = await pgPool.query<{aggregate_root_id: string}>(
            `SELECT aggregate_root_id FROM ${snapshotTable}`,
        );
        expect(rows.map(row => row.aggregate_root_id)).toEqual([databaseId]);
        expect(await snapshots.retrieve(aggregateRootId)).toEqual({
            aggregateRootId,
            version: 3,
            state: {counter: 1},
        });
    });

    test('stores the converted tenant identifier', async () => {
        const tenantDatabaseId = uuid.v7();
        const aggregateRootId = uuid.v7();
        const snapshots = new SnapshotRepositoryUsingPg<ContractStream>(asyncPool, tenantSnapshotTable, 1, {
            tenantContext: new ValueReadWriterUsingMemory(`tnt_${tenantDatabaseId}`),
            tenantIdConversion: new PrefixedBrandedIdConversion('tnt', new NoIdConversion<string>()),
        });

        await snapshots.store({aggregateRootId, version: 3, state: {counter: 1}});

        const {rows} = await pgPool.query<{tenant_id: string}>(`SELECT tenant_id FROM ${tenantSnapshotTable}`);
        expect(rows.map(row => row.tenant_id)).toEqual([tenantDatabaseId]);
        expect(await snapshots.retrieve(aggregateRootId)).not.toBeUndefined();
    });
});

describe('SnapshotRepositoryUsingPg tenant isolation', () => {
    let asyncPool: AsyncPgPool;
    let aggregateRootId: string;

    const repositoryFor = (tenantId: string | undefined) =>
        new SnapshotRepositoryUsingPg<ContractStream>(asyncPool, tenantSnapshotTable, 1, {
            tenantContext: new ValueReadWriterUsingMemory<string>(tenantId),
        });

    beforeEach(() => {
        aggregateRootId = uuid.v7();
        asyncPool = new AsyncPgPool(pgPool);
    });

    afterEach(async () => {
        await asyncPool.flush();
        await pgPool.query(`TRUNCATE TABLE ${tenantSnapshotTable}`);
    });

    test('never hands one tenant the snapshot of another, even for the same aggregate', async () => {
        const firstTenant = repositoryFor(firstTenantId);
        const secondTenant = repositoryFor(secondTenantId);
        await firstTenant.store({aggregateRootId, version: 5, state: {counter: 42, owner: 'first'}});

        expect(await secondTenant.retrieve(aggregateRootId)).toBeUndefined();

        await secondTenant.store({aggregateRootId, version: 9, state: {counter: 7, owner: 'second'}});

        expect(await firstTenant.retrieve(aggregateRootId)).toEqual({
            aggregateRootId,
            version: 5,
            state: {counter: 42, owner: 'first'},
        });
        expect(await secondTenant.retrieve(aggregateRootId)).toEqual({
            aggregateRootId,
            version: 9,
            state: {counter: 7, owner: 'second'},
        });
    });

    test('does not let one tenant overwrite the snapshot of another', async () => {
        const firstTenant = repositoryFor(firstTenantId);
        const secondTenant = repositoryFor(secondTenantId);
        await firstTenant.store({aggregateRootId, version: 5, state: {owner: 'first'}});

        await secondTenant.store({aggregateRootId, version: 5, state: {owner: 'second'}});

        expect((await firstTenant.retrieve(aggregateRootId))?.state).toEqual({owner: 'first'});
        const {rows} = await pgPool.query<{count: string}>(
            `SELECT count(*) AS count FROM ${tenantSnapshotTable} WHERE aggregate_root_id = $1`,
            [aggregateRootId],
        );
        expect(Number(rows[0].count)).toEqual(2);
    });

    test('does not let one tenant clear the snapshots of another', async () => {
        const firstTenant = repositoryFor(firstTenantId);
        const secondTenant = repositoryFor(secondTenantId);
        await firstTenant.store({aggregateRootId, version: 5, state: {owner: 'first'}});
        await secondTenant.store({aggregateRootId, version: 5, state: {owner: 'second'}});

        await firstTenant.clear();

        expect(await firstTenant.retrieve(aggregateRootId)).toBeUndefined();
        expect((await secondTenant.retrieve(aggregateRootId))?.state).toEqual({owner: 'second'});
    });

    test('refuses to read, write or clear when the tenant is unknown', async () => {
        const withoutTenant = repositoryFor(undefined);

        await expect(withoutTenant.store({aggregateRootId, version: 1, state: {counter: 1}})).rejects.toThrow(
            /Value is not found/,
        );
        await expect(withoutTenant.retrieve(aggregateRootId)).rejects.toThrow(/Value is not found/);
        await expect(withoutTenant.clear()).rejects.toThrow(/Value is not found/);
    });

    /**
     * The tenant filter is a property of the repository, not of the table. A repository
     * that is configured without a tenant context reads straight across every tenant,
     * which is worth knowing when wiring one up.
     */
    test('reads across tenants when it is configured without a tenant context', async () => {
        await repositoryFor(firstTenantId).store({aggregateRootId, version: 5, state: {owner: 'first'}});
        const withoutTenantScoping = new SnapshotRepositoryUsingPg<ContractStream>(
            asyncPool,
            tenantSnapshotTable,
            1,
        );

        expect(await withoutTenantScoping.retrieve(aggregateRootId)).not.toBeUndefined();
    });
});

describe('writing a snapshot and its events in one transaction', () => {
    let asyncPool: AsyncPgPool;
    let transactions: TransactionManagerUsingPg;
    let snapshots: SnapshotRepositoryUsingPg<OrderStream>;
    let repository: AggregateRootRepositoryWithSnapshotting<OrderStream>;
    let orderId: string;

    const storedVersions = async (): Promise<number[]> => {
        const {rows} = await pgPool.query<{version: string}>(
            `SELECT version FROM ${eventsTable} WHERE aggregate_root_id = $1 ORDER BY version`,
            [orderId],
        );

        return rows.map(row => Number(row.version));
    };

    beforeEach(() => {
        orderId = uuid.v7();
        asyncPool = new AsyncPgPool(pgPool);
        transactions = new TransactionManagerUsingPg(asyncPool);
        snapshots = new SnapshotRepositoryUsingPg<OrderStream>(asyncPool, snapshotTable, 1);
        repository = new AggregateRootRepositoryWithSnapshotting<OrderStream>(
            Order,
            snapshots,
            new MessageRepositoryUsingPg<OrderStream>(asyncPool, eventsTable),
            undefined,
            undefined,
            false,
            transactions,
        );
    });

    afterEach(async () => {
        await asyncPool.flush();
        await pgPool.query(`TRUNCATE TABLE ${snapshotTable}`);
        await pgPool.query(`TRUNCATE TABLE ${eventsTable} RESTART IDENTITY`);
    });

    test('commits the snapshot together with the events', async () => {
        const order = Order.place(orderId, 'frank', 100);
        order.addItem('sku-1', 2);

        await repository.persist(order);

        expect(await storedVersions()).toEqual([1, 2]);
        expect(await snapshots.retrieve(orderId)).toEqual({
            aggregateRootId: orderId,
            version: 2,
            state: {customer: 'frank', total: 100, items: {'sku-1': 2}, shipped: false},
        });
    });

    test('leaves neither the snapshot nor the events behind when the caller rolls back', async () => {
        await expect(
            transactions.runInTransaction(async () => {
                await repository.persist(Order.place(orderId, 'frank', 100));
                throw new Error('the command handler changed its mind');
            }),
        ).rejects.toThrow('the command handler changed its mind');

        expect(await storedVersions()).toEqual([]);
        expect(await snapshots.retrieve(orderId)).toBeUndefined();
    });

    test('leaves no snapshot behind when writing the events fails inside its own transaction', async () => {
        const order = Order.place(orderId, 'frank', 100);
        await repository.persist(order);
        const replayed = await repository.retrieve(orderId);
        replayed.addItem('sku-1', 1);
        const conflicting = await repository.retrieve(orderId);
        conflicting.addItem('sku-2', 1);
        await repository.persist(replayed);

        await expect(repository.persist(conflicting)).rejects.toThrow(/unique constraint/);

        expect(await storedVersions()).toEqual([1, 2]);
        expect(await snapshots.retrieve(orderId)).toEqual({
            aggregateRootId: orderId,
            version: 2,
            state: {customer: 'frank', total: 100, items: {'sku-1': 1}, shipped: false},
        });
    });
});
