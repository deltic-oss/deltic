import {OffsetRepositoryUsingMemory} from './memory.js';
import type {OffsetRepository} from '@deltic/offset-tracking';
import {Pool} from 'pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {pgTestCredentials} from '../../pg-credentials.js';
import {OffsetRepositoryUsingPg} from './pg.js';

const identifier = 'test-identifier';
const consumerName = 'test_consumer';
const tableName = 'test_offsets';

/**
 * Tracker keys are namespaced per run and per call so that a re-run, a retry, or a
 * parallel run against the same database can never observe another attempt's offsets.
 */
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let keySequence = 0;
const uniqueKey = (label: string): string => `${runId}:${label}:${keySequence++}`;

let pool: Pool;
let asyncPool: AsyncPgPool;

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
});

afterEach(async () => {
    await asyncPool.flush();
});

afterAll(async () => {
    await pool.end();
});

describe.each([
    ['Memory', () => new OffsetRepositoryUsingMemory()],
    [
        'Pg',
        () =>
            new OffsetRepositoryUsingPg<number>(asyncPool, {
                tableName,
                consumerName,
            }),
    ],
] as const)('OffsetRepositoryUsing%s', (_name, factory) => {
    let repository: OffsetRepository;

    beforeEach(() => {
        repository = factory();
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

    test('it reports no offset for a tracker that was never stored', async () => {
        // when
        const offset = await repository.retrieve(uniqueKey('never-stored'));

        // then
        expect(offset).toBeUndefined();
    });

    test('it distinguishes an offset of zero from a missing offset', async () => {
        // given
        const key = uniqueKey('zero');

        // when
        await repository.store(key, 0);

        // then
        const offset = await repository.retrieve(key);
        expect(offset).toBe(0);
        expect(offset).not.toBeUndefined();
        // a consumer resuming with `retrieve() ?? 0` must not treat 0 as "start over"
        expect(offset ?? 'missing').toBe(0);
    });

    test('it keeps offsets for separate trackers independent', async () => {
        // given
        const first = uniqueKey('independent-a');
        const second = uniqueKey('independent-b');
        const third = uniqueKey('independent-c');

        // when
        await repository.store(first, 1);
        await repository.store(second, 2);
        await repository.store(third, 3);
        await repository.store(second, 20);

        // then
        expect(await repository.retrieve(first)).toBe(1);
        expect(await repository.retrieve(second)).toBe(20);
        expect(await repository.retrieve(third)).toBe(3);
    });

    test('it does not confuse trackers whose keys overlap or contain separator characters', async () => {
        // given
        const base = uniqueKey('separator');
        const keys = [base, `${base}:`, `${base}:extra`, `${base}|extra`, `${base}.extra`, `${base} `];

        // when
        for (const [index, key] of keys.entries()) {
            await repository.store(key, index + 1);
        }

        // then
        for (const [index, key] of keys.entries()) {
            expect(await repository.retrieve(key)).toBe(index + 1);
        }
    });

    test('it accepts empty, unicode and prototype-shaped tracker keys', async () => {
        // given
        const keys = ['', '__proto__', 'constructor', 'prototype', 'офсет-🔖'];

        // when
        for (const [index, key] of keys.entries()) {
            await repository.store(`${runId}${key}`, index + 100);
        }

        // then
        for (const [index, key] of keys.entries()) {
            expect(await repository.retrieve(`${runId}${key}`)).toBe(index + 100);
        }
        expect(Object.hasOwn({}, runId)).toBe(false);
        expect(({} as Record<string, unknown>)[`${runId}__proto__`]).toBeUndefined();
    });

    test('it stores the same offset twice without changing the outcome', async () => {
        // given
        const key = uniqueKey('idempotent');
        await repository.store(key, 7);

        // when
        await repository.store(key, 7);
        await repository.store(key, 7);

        // then
        expect(await repository.retrieve(key)).toBe(7);
    });

    /**
     * The last offset stored wins, also when it is lower: moving a tracker back is how a consumer
     * replays or rebuilds.
     */
    test('it moves a tracker backwards when a lower offset is stored', async () => {
        // given
        const key = uniqueKey('rewind');
        await repository.store(key, 100);

        // when
        await repository.store(key, 5);

        // then
        expect(await repository.retrieve(key)).toBe(5);
    });

    test('it stores negative offsets', async () => {
        // given
        const key = uniqueKey('negative');

        // when
        await repository.store(key, -1);

        // then
        expect(await repository.retrieve(key)).toBe(-1);
    });

});

describe('OffsetRepositoryUsingPg', () => {
    let repository: OffsetRepository;

    beforeEach(() => {
        repository = new OffsetRepositoryUsingPg<number>(asyncPool, {tableName, consumerName});
    });

    test('it keeps offsets of different consumers on the same table independent', async () => {
        // given
        const key = uniqueKey('shared-table');
        const projection = new OffsetRepositoryUsingPg<number>(asyncPool, {
            tableName,
            consumerName: `${runId}-projection`,
        });
        const reporting = new OffsetRepositoryUsingPg<number>(asyncPool, {
            tableName,
            consumerName: `${runId}-reporting`,
        });

        // when
        await projection.store(key, 40);
        await reporting.store(key, 41);

        // then
        expect(await projection.retrieve(key)).toBe(40);
        expect(await reporting.retrieve(key)).toBe(41);
    });

    test('it cannot reach another consumer offset by shifting the separator between consumer and tracker', async () => {
        // given a consumer/tracker pair that would collide under a concatenated key
        const suffix = uniqueKey('namespace');
        const outer = new OffsetRepositoryUsingPg<number>(asyncPool, {
            tableName,
            consumerName: `alpha:beta-${suffix}`,
        });
        const inner = new OffsetRepositoryUsingPg<number>(asyncPool, {
            tableName,
            consumerName: `alpha-${suffix}`,
        });

        // when
        await outer.store('gamma', 1);
        await inner.store(`beta-${suffix}:gamma`, 2);

        // then
        expect(await outer.retrieve('gamma')).toBe(1);
        expect(await inner.retrieve(`beta-${suffix}:gamma`)).toBe(2);
    });

    it('it reads the current offset when selectForUpdate is enabled', async () => {
        // given
        const key = uniqueKey('select-for-update');
        await repository.store(key, 21);
        const locking = new OffsetRepositoryUsingPg<number>(asyncPool, {
            tableName,
            consumerName,
            selectForUpdate: true,
        });

        // then
        await expect(locking.retrieve(key)).resolves.toBe(21);
    });
});

describe('OffsetRepositoryUsingMemory', () => {
    test('it keeps offsets per instance', async () => {
        // given
        const first = new OffsetRepositoryUsingMemory();
        const second = new OffsetRepositoryUsingMemory();

        // when
        await first.store(identifier, 3);

        // then
        expect(await first.retrieve(identifier)).toBe(3);
        expect(await second.retrieve(identifier)).toBeUndefined();
    });

});
