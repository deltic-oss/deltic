import type {KeyValueStore, ValueType} from './index.js';
import {KeyValueStoreUsingMemory} from './memory.js';
import {createKeyValueSchemaQuery, KeyValueStoreUsingPg} from './pg.js';
import {Pool} from 'pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {ValueReadWriterUsingMemory} from '@deltic/context';
import {pgTestCredentials} from '../../pg-credentials.js';

type ExampleKey = string | {first: number; second: number};
type ExampleValue = ValueType;
let store: KeyValueStore<ExampleKey, ExampleValue>;

let pool: Pool;
let asyncPool: AsyncPgPool;

const makePgStore = () => {
    return new KeyValueStoreUsingPg<ExampleKey, ExampleValue>(asyncPool, {
        tableName: 'test__kv_store',
        keyConversion: key => `prefixed:${key}`,
    });
};

const makeInMemoryStore = () => {
    return new KeyValueStoreUsingMemory<ExampleKey, ExampleValue>();
};

describe.each([
    ['Memory', makeInMemoryStore, false],
    ['Pg', makePgStore, true],
])('KeyValueStoreUsing%s', (_name, factory: () => KeyValueStore<ExampleKey, ExampleValue>, usesDatabase: boolean) => {
    beforeAll(async () => {
        if (!usesDatabase) {
            return;
        }
        pool = new Pool(pgTestCredentials);
        await pool.query('DROP TABLE IF EXISTS test__kv_store');
        await pool.query(createKeyValueSchemaQuery('test__kv_store'));
    });
    beforeEach(() => {
        asyncPool = new AsyncPgPool(pool);
        store = factory();
    });
    afterEach(async () => {
        await store.clear();

        if (!usesDatabase) {
            return;
        }

        await asyncPool.flush();
    });
    afterAll(async () => {
        if (!usesDatabase) {
            return;
        }

        await asyncPool.flush();
        await pool.end();
    });

    test.each([
        ['number', 1],
        ['boolean', false],
        ['string', 'example'],
        ['object', {name: 'Frank', age: 35}],
        ['array', [1, 'two', {three: true}, null]],
    ])('stored value of type %s can be retrieved', async (_name, value: ExampleValue) => {
        // arrange
        const key: ExampleKey = 'key-a';

        // act
        await store.persist(key, value);
        const retrievedValue = await store.retrieve(key);

        // assert
        expect(retrievedValue).toEqual(value);
    });

    test('clearing the store', async () => {
        await store.persist('duna', 'awesome');
        await store.persist('onboarding', 'valhalla');

        await store.clear();

        expect(await store.retrieve('duna')).toBeUndefined();
    });

    test('retrieving a value that does not exist', async () => {
        // act
        const retrievedValue = await store.retrieve('unknown');

        // assert
        expect(retrievedValue).toBeUndefined();
    });

    test('values can be overwritten', async () => {
        // arrange
        const key: ExampleKey = 'key-a';
        await store.persist(key, {name: 'Original', age: 40});
        const newValue: ExampleValue = {name: 'Frank', age: 35};

        // act
        await store.persist(key, newValue);
        const retrievedValue = await store.retrieve(key);

        // assert
        expect(retrievedValue).toEqual(newValue);
    });

    test('values can be removed', async () => {
        // arrange
        const key: ExampleKey = 'key-a';
        await store.persist(key, {name: 'Original', age: 40});

        // act
        await store.remove(key);
        const retrievedValue = await store.retrieve(key);

        // assert
        expect(retrievedValue).toBeUndefined();
    });

    test('can store values with objects as keys', async () => {
        // arrange
        const key: ExampleKey = {first: 1234, second: 4331};
        const value = {name: 'Original', age: 40};
        await store.persist(key, value);

        // act
        const retrievedValue = await store.retrieve(key);

        // assert
        expect(retrievedValue).toEqual(value);
    });

    test('can remove values with objects as keys', async () => {
        // arrange
        const key: ExampleKey = {first: 1234, second: 4331};
        await store.persist(key, {name: 'Original', age: 40});

        // act
        await store.remove(key);
        const retrievedValue = await store.retrieve(key);

        // assert
        expect(retrievedValue).toBeUndefined();
    });

    test.each([
        ['zero', 0],
        ['an empty string', ''],
        ['false', false],
        ['null', null],
    ])('a stored value of %s is not mistaken for a missing key', async (_name, value: ExampleValue) => {
        // arrange
        const key: ExampleKey = 'falsy-value';

        // act
        await store.persist(key, value);

        // assert
        expect(await store.retrieve(key)).toStrictEqual(value);
    });

    test('a stored undefined is indistinguishable from a missing key', async () => {
        await store.persist('explicitly-undefined', undefined);

        expect(await store.retrieve('explicitly-undefined')).toBeUndefined();
    });

    test('nested structures survive the round trip', async () => {
        // arrange
        const value: ExampleValue = {
            profile: {name: 'Frank', tags: ['owner', 'admin']},
            history: [[1, 2], [3], []],
            counters: {views: 0, likes: 12},
            active: false,
        };

        // act
        await store.persist('nested', value);

        // assert
        expect(await store.retrieve('nested')).toEqual(value);
    });

    test('unicode keys and values survive the round trip', async () => {
        // arrange
        const key = 'käse-日本語-ключ-🧀';
        const value = {label: 'Grüße 🧀 日本語 ключ'};

        // act
        await store.persist(key, value);

        // assert
        expect(await store.retrieve(key)).toEqual(value);
    });

    test('keys containing sql metacharacters are treated as literal keys', async () => {
        // arrange
        const injectionKey = "o'brien'); DROP TABLE not_a_real_table; --";

        // act
        await store.persist(injectionKey, 'injected');
        await store.persist('%', 'percent');
        await store.persist('_', 'underscore');
        await store.persist('anything', 'literal');

        // assert
        expect(await store.retrieve(injectionKey)).toBe('injected');
        expect(await store.retrieve('%')).toBe('percent');
        expect(await store.retrieve('_')).toBe('underscore');
    });

    test.each(['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf'])(
        'a fresh store reports no value for the key %s',
        async (key: string) => {
            expect(await store.retrieve(key)).toBeUndefined();
        },
    );

    test('a value stored under __proto__ does not pollute the object prototype', async () => {
        // act
        await store.persist('__proto__', {polluted: true});

        // assert
        expect(await store.retrieve('__proto__')).toEqual({polluted: true});
        expect(await store.retrieve('constructor')).toBeUndefined();
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    test('removing a key that was never stored is not an error', async () => {
        await expect(store.remove('never-stored')).resolves.toBeUndefined();
    });

    test('clearing an empty store is not an error', async () => {
        await expect(store.clear()).resolves.toBeUndefined();
    });

    test('removing a key leaves keys that share its prefix intact', async () => {
        // arrange
        await store.persist('user', 'plain');
        await store.persist('user:1', 'scoped');
        await store.persist('users', 'plural');

        // act
        await store.remove('user');

        // assert
        expect(await store.retrieve('user')).toBeUndefined();
        expect(await store.retrieve('user:1')).toBe('scoped');
        expect(await store.retrieve('users')).toBe('plural');
    });

    test('a value can be overwritten with a value of a different shape', async () => {
        // arrange
        await store.persist('shape', {name: 'Frank'});

        // act
        await store.persist('shape', 'just a string');

        // assert
        expect(await store.retrieve('shape')).toBe('just a string');
    });

    test('interleaved read-modify-write cycles overwrite each other', async () => {
        // arrange, the store offers no compare-and-swap, so the last write wins
        await store.persist('counter', 0);

        // act
        const readByFirst = (await store.retrieve('counter')) as number;
        const readBySecond = (await store.retrieve('counter')) as number;
        await store.persist('counter', readByFirst + 1);
        await store.persist('counter', readBySecond + 1);

        // assert
        expect(await store.retrieve('counter')).toBe(1);
    });
});

describe('KeyValueStoreUsingMemory', () => {
    let memoryStore: KeyValueStoreUsingMemory<ExampleKey, ExampleValue>;

    beforeEach(() => {
        memoryStore = new KeyValueStoreUsingMemory<ExampleKey, ExampleValue>();
    });

    test('object keys are matched regardless of property order', async () => {
        // arrange
        await memoryStore.persist({first: 1, second: 2}, 'stored');

        // act
        const retrieved = await memoryStore.retrieve({second: 2, first: 1} as ExampleKey);

        // assert
        expect(retrieved).toBe('stored');
    });

    test('keys longer than the postgres schema allows are accepted', async () => {
        // arrange, the postgres schema caps keys at 255 characters
        const key = 'x'.repeat(300);

        // act
        await memoryStore.persist(key, 'long key value');

        // assert
        expect(await memoryStore.retrieve(key)).toBe('long key value');
    });

    test('a stored date is returned as a date', async () => {
        // arrange
        const value = {occurredAt: new Date('2024-05-06T07:08:09.000Z')};

        // act
        await memoryStore.persist('with-date', value);

        // assert
        expect(await memoryStore.retrieve('with-date')).toStrictEqual(value);
    });

    test('a stored NaN is returned as NaN', async () => {
        await memoryStore.persist('not-a-number', Number.NaN);

        expect(await memoryStore.retrieve('not-a-number')).toBeNaN();
    });
});

describe('KeyValueStoreUsingPg', () => {
    const tableName = 'test__kv_store_variants';
    let ownPool: Pool;
    let ownAsyncPool: AsyncPgPool;

    beforeAll(async () => {
        ownPool = new Pool({...pgTestCredentials, max: 2});
        await ownPool.query(`DROP TABLE IF EXISTS ${tableName}`);
        await ownPool.query(createKeyValueSchemaQuery(tableName));
    });

    beforeEach(() => {
        ownAsyncPool = new AsyncPgPool(ownPool);
    });

    afterEach(async () => {
        await ownAsyncPool.flush();
        await ownPool.query(`TRUNCATE TABLE ${tableName}`);
    });

    afterAll(async () => {
        await ownPool.query(`DROP TABLE IF EXISTS ${tableName}`);
        await ownPool.end();
    });

    describe('value fidelity', () => {
        let pgStore: KeyValueStore<string, ExampleValue>;

        beforeEach(() => {
            pgStore = new KeyValueStoreUsingPg<string, ExampleValue>(ownAsyncPool, {tableName});
        });

        // see .claude-work/issues/key-value-pg-json-round-trip-changes-values.md
        it.fails('returns a stored date as a date', async () => {
            const value = {occurredAt: new Date('2024-05-06T07:08:09.000Z')};

            await pgStore.persist('with-date', value);

            expect(await pgStore.retrieve('with-date')).toStrictEqual(value);
        });

        // see .claude-work/issues/key-value-pg-json-round-trip-changes-values.md
        it.fails('returns a stored NaN as NaN', async () => {
            await pgStore.persist('not-a-number', Number.NaN);

            expect(await pgStore.retrieve('not-a-number')).toBeNaN();
        });

        test('a large value survives the round trip', async () => {
            const value = {blob: 'a'.repeat(200_000)};

            await pgStore.persist('large', value);

            expect(await pgStore.retrieve('large')).toEqual(value);
        });
    });

    describe('keys', () => {
        let pgStore: KeyValueStore<string, ExampleValue>;

        beforeEach(() => {
            pgStore = new KeyValueStoreUsingPg<string, ExampleValue>(ownAsyncPool, {tableName});
        });

        test('a key that exceeds the schema key length is rejected instead of being truncated', async () => {
            await expect(pgStore.persist('x'.repeat(300), 'value')).rejects.toThrow(/too long/);
        });

        test('keys at the schema key length are accepted', async () => {
            const key = 'x'.repeat(255);

            await pgStore.persist(key, 'value');

            expect(await pgStore.retrieve(key)).toBe('value');
        });
    });

    describe('object keys', () => {
        type ObjectKey = {first: number; second: number};
        let pgStore: KeyValueStore<ObjectKey, ExampleValue>;

        beforeEach(() => {
            pgStore = new KeyValueStoreUsingPg<ObjectKey, ExampleValue>(ownAsyncPool, {tableName});
        });

        test('distinct object keys address distinct values', async () => {
            await pgStore.persist({first: 1, second: 2}, 'one-two');
            await pgStore.persist({first: 3, second: 4}, 'three-four');

            expect(await pgStore.retrieve({first: 1, second: 2})).toBe('one-two');
            expect(await pgStore.retrieve({first: 3, second: 4})).toBe('three-four');
        });

        // see .claude-work/issues/key-value-object-keys-are-not-canonical-in-pg.md
        it.fails('object keys are matched regardless of property order', async () => {
            await pgStore.persist({first: 1, second: 2}, 'stored');

            expect(await pgStore.retrieve({second: 2, first: 1})).toBe('stored');
        });
    });

    describe('tenant scoping', () => {
        const tenantA = '018f8e2a-0000-7000-8000-00000000000a';
        const tenantB = '018f8e2a-0000-7000-8000-00000000000b';
        let tenantContext: ValueReadWriterUsingMemory<string>;
        let tenantStore: KeyValueStore<string, ExampleValue>;

        beforeEach(() => {
            tenantContext = new ValueReadWriterUsingMemory<string>(tenantA);
            tenantStore = new KeyValueStoreUsingPg<string, ExampleValue, string, string>(ownAsyncPool, {
                tableName,
                tenantContext,
            });
        });

        test('persisting requires a resolvable tenant', async () => {
            tenantContext.forget();

            await expect(tenantStore.persist('key', 'value')).rejects.toThrow();
        });

        test('the same key holds a separate value per tenant', async () => {
            await tenantStore.persist('shared-key', 'tenant-a-value');
            tenantContext.use(tenantB);
            await tenantStore.persist('shared-key', 'tenant-b-value');

            const {rows} = await ownPool.query<{tenant_id: string}>(
                `SELECT tenant_id FROM ${tableName} WHERE "key" = 'shared-key' ORDER BY tenant_id`,
            );

            expect(rows.map(row => row.tenant_id)).toEqual([tenantA, tenantB]);
        });

        // see .claude-work/issues/key-value-pg-ignores-tenant-on-read-and-remove.md
        it.fails('retrieving only returns the value of the current tenant', async () => {
            await tenantStore.persist('shared-key', 'tenant-a-value');

            tenantContext.use(tenantB);

            expect(await tenantStore.retrieve('shared-key')).toBeUndefined();
        });

        // see .claude-work/issues/key-value-pg-ignores-tenant-on-read-and-remove.md
        it.fails('removing only removes the value of the current tenant', async () => {
            await tenantStore.persist('shared-key', 'tenant-a-value');
            tenantContext.use(tenantB);
            await tenantStore.persist('shared-key', 'tenant-b-value');

            await tenantStore.remove('shared-key');

            const {rows} = await ownPool.query<{tenant_id: string}>(
                `SELECT tenant_id FROM ${tableName} WHERE "key" = 'shared-key'`,
            );
            expect(rows.map(row => row.tenant_id)).toEqual([tenantA]);
        });

        // see .claude-work/issues/key-value-pg-clear-truncates-all-tenants.md
        it.fails('clearing only removes the entries of the current tenant', async () => {
            await tenantStore.persist('key-a', 'tenant-a-value');
            tenantContext.use(tenantB);
            await tenantStore.persist('key-b', 'tenant-b-value');

            await tenantStore.clear();

            const {rows} = await ownPool.query<{tenant_id: string}>(`SELECT tenant_id FROM ${tableName}`);
            expect(rows.map(row => row.tenant_id)).toEqual([tenantA]);
        });
    });

    describe('connection handling', () => {
        let pgStore: KeyValueStore<string, ExampleValue>;

        beforeEach(() => {
            pgStore = new KeyValueStoreUsingPg<string, ExampleValue>(ownAsyncPool, {tableName});
        });

        test.each([
            ['persist', (target: KeyValueStore<string, ExampleValue>) => target.persist('key', 'value')],
            ['retrieve', (target: KeyValueStore<string, ExampleValue>) => target.retrieve('key')],
            ['remove', (target: KeyValueStore<string, ExampleValue>) => target.remove('key')],
        ])('%s returns the connection it claimed to the pool', async (_name, operation) => {
            const releaseSpy = vi.spyOn(ownAsyncPool, 'release');

            try {
                await operation(pgStore);

                expect(releaseSpy).toHaveBeenCalledTimes(1);
            } finally {
                releaseSpy.mockRestore();
            }
        });

        // see .claude-work/issues/key-value-connections-not-returned-to-the-pool.md
        it.fails('clear returns the connection it claimed to the pool', async () => {
            const releaseSpy = vi.spyOn(ownAsyncPool, 'release');

            try {
                await pgStore.clear();

                expect(releaseSpy).toHaveBeenCalledTimes(1);
            } finally {
                releaseSpy.mockRestore();
            }
        });

        test('operations are rejected once the pool context has been flushed', async () => {
            await pgStore.persist('key', 'value');
            await ownAsyncPool.flush();

            await expect(pgStore.retrieve('key')).rejects.toThrow(/already flushed/);
        });

        test('flushing the pool context twice is not an error', async () => {
            await pgStore.persist('key', 'value');
            await ownAsyncPool.flush();

            await expect(ownAsyncPool.flush()).resolves.toBeUndefined();
        });
    });
});

describe('KeyValueStoreUsingPg within a transaction', () => {
    const tableName = 'test__kv_store_transactions';
    let ownPool: Pool;
    let ownAsyncPool: AsyncPgPool;
    let pgStore: KeyValueStore<string, ExampleValue>;

    beforeAll(async () => {
        ownPool = new Pool({...pgTestCredentials, max: 2});
        await ownPool.query(`DROP TABLE IF EXISTS ${tableName}`);
        await ownPool.query(createKeyValueSchemaQuery(tableName));
    });

    beforeEach(() => {
        ownAsyncPool = new AsyncPgPool(ownPool);
        pgStore = new KeyValueStoreUsingPg<string, ExampleValue>(ownAsyncPool, {tableName});
    });

    afterEach(async () => {
        await ownAsyncPool.flush();
        await ownPool.query(`TRUNCATE TABLE ${tableName}`);
    });

    afterAll(async () => {
        await ownPool.query(`DROP TABLE IF EXISTS ${tableName}`);
        await ownPool.end();
    });

    test('a value persisted in a committed transaction is visible afterwards', async () => {
        await ownAsyncPool.primary();

        await ownAsyncPool.runInTransaction(() => pgStore.persist('committed', 'value'));

        expect(await pgStore.retrieve('committed')).toBe('value');
    });

    test('a value persisted in a rolled back transaction is not visible afterwards', async () => {
        await ownAsyncPool.primary();

        await expect(
            ownAsyncPool.runInTransaction(async () => {
                await pgStore.persist('rolled-back', 'value');
                throw new Error('reason to roll back');
            }),
        ).rejects.toThrow('reason to roll back');

        expect(await pgStore.retrieve('rolled-back')).toBeUndefined();
    });

    // persist() hands the isolated transaction's connection back to the pool, after which the pool
    // no longer recognises the transaction and refuses to finalise it
    it.fails('a value can be persisted inside an isolated transaction', async () => {
        await expect(
            ownAsyncPool.runInIsolatedTransaction(() => pgStore.persist('isolated', 'value')),
        ).resolves.toBeUndefined();
    });
});
