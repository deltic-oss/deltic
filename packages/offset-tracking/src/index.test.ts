import {OffsetRepositoryUsingMemory} from './memory.js';
import type {OffsetRepository} from '@deltic/offset-tracking';
import {Pool} from 'pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {pgTestCredentials} from '../../pg-credentials.js';
import {OffsetRepositoryUsingPg} from './pg.js';

const identifier = 'test-identifier';

let pool: Pool;
let asyncPool: AsyncPgPool;

describe.each([
    ['Memory', () => new OffsetRepositoryUsingMemory()],
    [
        'Pg',
        () =>
            new OffsetRepositoryUsingPg<number>(asyncPool, {
                tableName: 'test_offsets',
                consumerName: 'test_consumer',
            }),
    ],
] as const)('OffsetRepositoryUsing%s', (_name, factory) => {
    let repository: OffsetRepository;

    beforeAll(async () => {
        pool = new Pool(pgTestCredentials);

        await pool.query(`
            DROP TABLE IF EXISTS test_offsets;
            CREATE TABLE IF NOT EXISTS test_offsets (
    consumer VARCHAR(255) NOT NULL,
    identifier VARCHAR(255) NOT NULL,
    "offset" INT NOT NULL,
    updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (consumer, identifier)
);
        `);
    });

    beforeEach(() => {
        asyncPool = new AsyncPgPool(pool);
        repository = factory();
    });

    afterEach(async () => {
        await asyncPool.flush();
    });

    afterAll(async () => {
        await pool.end();
    });

    test('it can store and retrieve offsets', async () => {
        // when
        await repository.store(identifier, 10);

        // then
        const offset = await repository.retrieve(identifier);
        expect(offset).toEqual(10);
    });

    test('it can overwrite an offset', async () => {
        // given
        await repository.store(identifier, 10);

        // when
        await repository.store(identifier, 15);

        // then
        const offset = await repository.retrieve(identifier);
        expect(offset).toEqual(15);
    });
});
