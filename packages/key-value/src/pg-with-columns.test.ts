import {type KeyValueStore} from './index.js';
import {KeyValueStoreWithColumnsUsingPg} from './pg-with-columns.js';
import {Pool} from 'pg';
import * as uuid from 'uuid';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {ValueReadWriterUsingMemory} from '@deltic/context';
import {NoIdConversion, PrefixedBrandedIdConversion, PrefixedBrandedIdGenerator, type PrefixedId} from '@deltic/uid';
import {pgTestCredentials} from '../../pg-credentials.js';

type PersonId = PrefixedId<'person'>;

type ExampleObject = {
    name: string;
    age: number;
    personId: PersonId;
    likedLasagna: boolean;
    likesMushrooms: 'no' | 'hell-no';
    anotherUuid: string;
    myFriend: {email: string};
};
type ExampleIndex = Pick<ExampleObject, 'name' | 'age' | 'personId'>;

let pool: Pool;
let asyncPool: AsyncPgPool;

let store: KeyValueStore<ExampleIndex, ExampleObject>;

async function createKeyValueSchema(pool: Pool, tableName: string): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
            tenant_id UUID NOT NULL,
            name VARCHAR(255) NOT NULL,
            age INTEGER NOT NULL,
            id UUID NOT NULL,
            "likedLasagna" BOOLEAN NOT NULL DEFAULT FALSE,
            "anotherUuid" UUID,
            "myFriendsEmail" VARCHAR(255),
            deltic_payload JSON,
            PRIMARY KEY (tenant_id, name, age, id)
        );
    `);
}

const testTableName = 'test__kv_columnized_store';
const tenantId = uuid.v7();
const tenantContext = new ValueReadWriterUsingMemory<string>(tenantId);
const personIds = new PrefixedBrandedIdGenerator('person', uuid.v7);
const prefixUuidConversion = new PrefixedBrandedIdConversion('person', new NoIdConversion());

const makePgStore = (): KeyValueStoreWithColumnsUsingPg<ExampleIndex, ExampleObject> => {
    return new KeyValueStoreWithColumnsUsingPg<ExampleIndex, ExampleObject>(
        asyncPool,
        testTableName,
        [
            'name',
            'age',
            {
                payloadKey: 'personId',
                columnName: 'id',
                toDatabaseValue: prefixUuidConversion.toDatabase.bind(prefixUuidConversion),
            },
        ],
        [
            'likedLasagna',
            {payloadKey: 'anotherUuid'},
            {
                payloadKey: 'myFriend',
                columnName: 'myFriendsEmail',
                toDatabaseValue: friend => friend.email,
            },
        ],
        tenantContext,
        new NoIdConversion(),
    );
};

describe('KeyValueStoreWithColumnsUsingPg', () => {
    beforeAll(async () => {
        pool = new Pool(pgTestCredentials);

        await pool.query(`DROP TABLE IF EXISTS ${testTableName}`);
        await createKeyValueSchema(pool, testTableName);
    });

    beforeEach(() => {
        asyncPool = new AsyncPgPool(pool);
        store = makePgStore();
        tenantContext.use(uuid.v7());
    });

    afterEach(async () => {
        await store.clear();
        await asyncPool.flush();
    });

    afterAll(async () => {
        await pool.end();
    });

    const personId = personIds.generateId();

    const example: ExampleObject = {
        name: 'Frank',
        age: 36,
        personId,
        likedLasagna: false,
        likesMushrooms: 'no',
        anotherUuid: uuid.v7(),
        myFriend: {email: 'marge@sharknado.com'},
    };
    const exampleIndex: ExampleIndex = {
        name: 'Frank',
        age: 36,
        personId,
    };

    test('it can store and retrieve objects', async () => {
        await store.persist(exampleIndex, example);
        await store.persist(exampleIndex, example);

        const retrieved = await store.retrieve({name: 'Frank', age: 36, personId});

        expect(retrieved).toEqual(example);
    });

    test('when the tenant context is different, an entry is not found', async () => {
        await store.persist(exampleIndex, example);

        tenantContext.use(uuid.v7());
        const retrieved = await store.retrieve({name: 'Frank', age: 36, personId});

        expect(retrieved).toEqual(undefined);
    });

    test('it can update with changed persisted columns', async () => {
        const anotherUuid = uuid.v7();
        const example: ExampleObject = {
            name: 'Frank',
            age: 36,
            personId,
            likedLasagna: false,
            likesMushrooms: 'no',
            anotherUuid,
            myFriend: {email: 'marge@sharknado.com'},
        };

        const newExample: ExampleObject = {
            name: 'Frank',
            age: 36,
            personId,
            likedLasagna: true,
            likesMushrooms: 'hell-no',
            anotherUuid,
            myFriend: {email: 'homer@sharknado.com'},
        };
        await store.persist(exampleIndex, newExample);
        let retrieved = await store.retrieve({name: 'Frank', age: 36, personId});
        expect(retrieved).toEqual(newExample);

        await store.persist(exampleIndex, example);
        retrieved = await store.retrieve({name: 'Frank', age: 36, personId});
        expect(retrieved).toEqual(example);
    });

    test('can remove', async () => {
        // Given
        await store.persist(exampleIndex, example);
        let retrieved = await store.retrieve({name: 'Frank', age: 36, personId});
        expect(retrieved).toEqual(example);

        // When
        await store.remove({name: 'Frank', age: 36, personId});

        // Then
        retrieved = await store.retrieve({name: 'Frank', age: 36, personId});
        expect(retrieved).toBeUndefined();
    });

    test('properties that are not mapped to a column survive the round trip', async () => {
        await store.persist(exampleIndex, {...example, likesMushrooms: 'hell-no'});

        const retrieved = await store.retrieve(exampleIndex);

        expect(retrieved?.likesMushrooms).toBe('hell-no');
    });

    test('a value with sql metacharacters is stored as a literal value', async () => {
        // arrange
        const index: ExampleIndex = {name: "o'brien'); DROP TABLE not_a_real_table; --", age: 41, personId};

        // act
        await store.persist(index, {...example, name: index.name, age: 41});

        // assert
        expect(await store.retrieve(index)).toEqual({...example, name: index.name, age: 41});
    });

    test('the value of a column is derived from the value, not from the key', async () => {
        // arrange, the key and the value disagree about likedLasagna
        await store.persist(exampleIndex, {...example, likedLasagna: true});

        // act
        const {rows} = await pool.query<{likedLasagna: boolean}>(
            `SELECT "likedLasagna" FROM ${testTableName} WHERE name = 'Frank'`,
        );

        // assert
        expect(rows[0]?.likedLasagna).toBe(true);
    });

    test('a record can be persisted inside an isolated transaction', async () => {
        await asyncPool.runInIsolatedTransaction(() => store.persist(exampleIndex, example));

        expect(await store.retrieve(exampleIndex)).toEqual(example);
    });

    test('clearing the store removes every record', async () => {
        await store.persist(exampleIndex, example);

        await store.clear();

        expect(await store.retrieve(exampleIndex)).toBeUndefined();
    });

    test.each([
        ['persist', (target: KeyValueStore<ExampleIndex, ExampleObject>) => target.persist(exampleIndex, example)],
        ['retrieve', (target: KeyValueStore<ExampleIndex, ExampleObject>) => target.retrieve(exampleIndex)],
        ['remove', (target: KeyValueStore<ExampleIndex, ExampleObject>) => target.remove(exampleIndex)],
        ['clear', (target: KeyValueStore<ExampleIndex, ExampleObject>) => target.clear()],
    ])('%s returns the connection it claimed to the pool', async (_name, operation) => {
        const releaseSpy = vi.spyOn(asyncPool, 'release');

        try {
            await operation(store);

            expect(releaseSpy).toHaveBeenCalledTimes(1);
        } finally {
            releaseSpy.mockRestore();
        }
    });
});

describe('KeyValueStoreWithColumnsUsingPg column declarations', () => {
    type UserKey = {userId: string};
    type User = {userId: string; nickname: string};

    const snakeCaseTable = 'test__kv_columnized_snake_case';
    const camelCaseTable = 'test__kv_columnized_camel_case';
    let ownPool: Pool;
    let ownAsyncPool: AsyncPgPool;

    beforeAll(async () => {
        ownPool = new Pool({...pgTestCredentials, max: 2});
        await ownPool.query(`DROP TABLE IF EXISTS ${snakeCaseTable}`);
        await ownPool.query(`
            CREATE TABLE ${snakeCaseTable} (
                user_id VARCHAR(255) NOT NULL,
                deltic_payload JSON,
                PRIMARY KEY (user_id)
            );
        `);
        await ownPool.query(`DROP TABLE IF EXISTS ${camelCaseTable}`);
        await ownPool.query(`
            CREATE TABLE ${camelCaseTable} (
                "userId" VARCHAR(255) NOT NULL,
                deltic_payload JSON,
                PRIMARY KEY ("userId")
            );
        `);
    });

    beforeEach(() => {
        ownAsyncPool = new AsyncPgPool(ownPool);
    });

    afterEach(async () => {
        await ownPool.query(`TRUNCATE TABLE ${snakeCaseTable}`);
        await ownPool.query(`TRUNCATE TABLE ${camelCaseTable}`);
        await ownAsyncPool.flush();
    });

    afterAll(async () => {
        await ownPool.query(`DROP TABLE IF EXISTS ${snakeCaseTable}`);
        await ownPool.query(`DROP TABLE IF EXISTS ${camelCaseTable}`);
        await ownPool.end();
    });

    const makeRenamedColumnStore = (): KeyValueStore<UserKey, User> =>
        new KeyValueStoreWithColumnsUsingPg<UserKey, User>(
            ownAsyncPool,
            snakeCaseTable,
            [{payloadKey: 'userId', columnName: 'user_id'}],
            [],
        );

    test('an identity column declared without a value conversion is written to the renamed column', async () => {
        const store = makeRenamedColumnStore();

        await store.persist({userId: 'user-1'}, {userId: 'user-1', nickname: 'Alice'});

        const {rows} = await ownPool.query<{user_id: string}>(`SELECT user_id FROM ${snakeCaseTable}`);
        expect(rows.map(row => row.user_id)).toEqual(['user-1']);
    });

});

describe('KeyValueStoreWithColumnsUsingPg with a numeric tenant id', () => {
    type UserKey = {user_id: string};
    type User = {user_id: string; nickname: string};

    const numericTenantTable = 'test__kv_columnized_numeric_tenant';
    let ownPool: Pool;
    let ownAsyncPool: AsyncPgPool;
    let numericTenantContext: ValueReadWriterUsingMemory<number>;
    let store: KeyValueStore<UserKey, User>;

    beforeAll(async () => {
        ownPool = new Pool({...pgTestCredentials, max: 2});
        await ownPool.query(`DROP TABLE IF EXISTS ${numericTenantTable}`);
        await ownPool.query(`
            CREATE TABLE ${numericTenantTable} (
                tenant_id INTEGER NOT NULL,
                user_id VARCHAR(255) NOT NULL,
                deltic_payload JSON,
                PRIMARY KEY (tenant_id, user_id)
            );
        `);
    });

    beforeEach(() => {
        ownAsyncPool = new AsyncPgPool(ownPool);
        numericTenantContext = new ValueReadWriterUsingMemory<number>(7);
        store = new KeyValueStoreWithColumnsUsingPg<UserKey, User, number>(
            ownAsyncPool,
            numericTenantTable,
            ['user_id'],
            [],
            numericTenantContext,
        );
    });

    afterEach(async () => {
        await ownPool.query(`TRUNCATE TABLE ${numericTenantTable}`);
        await ownAsyncPool.flush();
    });

    afterAll(async () => {
        await ownPool.query(`DROP TABLE IF EXISTS ${numericTenantTable}`);
        await ownPool.end();
    });

    test('records are scoped to a non-zero tenant', async () => {
        await store.persist({user_id: 'u1'}, {user_id: 'u1', nickname: 'Seven'});

        numericTenantContext.use(8);

        expect(await store.retrieve({user_id: 'u1'})).toBeUndefined();
    });

});
