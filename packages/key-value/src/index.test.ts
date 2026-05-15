import type {KeyValueStore, ValueType} from './index.js';
import {KeyValueStoreUsingMemory} from './memory.js';
import {createKeyValueSchemaQuery, KeyValueStoreUsingPg} from './pg.js';
import {Pool} from 'pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';
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
        asyncPool = new AsyncPgPool(pool);

        await pool.query('DROP TABLE IF EXISTS test__kv_store');
        await pool.query(createKeyValueSchemaQuery('test__kv_store'));
    });
    beforeEach(() => {
        store = factory();
    });
    afterEach(async () => {
        if (!usesDatabase) {
            return;
        }

        await asyncPool.flush();
    });
    afterAll(async () => {
        await store.clear();

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
});
