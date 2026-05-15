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
    likesMushrooms: boolean;
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
        likesMushrooms: false,
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
            likesMushrooms: false,
            anotherUuid,
            myFriend: {email: 'marge@sharknado.com'},
        };

        const newExample = {
            name: 'Frank',
            age: 36,
            personId,
            likedLasagna: true,
            likesMushrooms: true,
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
});
