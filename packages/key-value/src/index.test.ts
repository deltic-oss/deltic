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

    });
});
