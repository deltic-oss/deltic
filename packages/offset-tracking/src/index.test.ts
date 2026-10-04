import {OffsetRepositoryUsingMemory} from './memory.js';
import type {OffsetRepository} from '@deltic/offset-tracking';
import {Pool} from 'pg';
import {AsyncPgPool} from '@deltic/async-pg-pool';
import {pgTestCredentials} from '../../pg-credentials.js';
import {OffsetRepositoryUsingPg} from './pg.js';

const identifier = 'test-identifier';
const consumerName = 'test_consumer';
const tableName = 'test_offsets';
const bigintTableName = 'test_offsets_bigint';

/**
 * Tracker keys are namespaced per run and per call so that a re-run, a retry, or a
 * parallel run against the same database can never observe another attempt's offsets.
 */
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
let keySequence = 0;
const uniqueKey = (label: string): string => `${runId}:${label}:${keySequence++}`;

let pool: Pool;
let asyncPool: AsyncPgPool;

const storedOffsetOutsideTheAsyncPool = async (
    key: string,
    consumer: string = consumerName,
    table: string = tableName,
): Promise<number | string | undefined> => {
    const result = await pool.query<{offset: number | string}>(
        `SELECT "offset" FROM ${table} WHERE consumer = $1 AND identifier = $2`,
        [consumer, key],
    );

    return result.rows[0]?.offset;
};

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
        DROP TABLE IF EXISTS test_offsets_bigint;
        CREATE TABLE IF NOT EXISTS test_offsets_bigint (
    consumer VARCHAR(255) NOT NULL,
    identifier VARCHAR(255) NOT NULL,
    "offset" BIGINT NOT NULL,
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
     * Documents the absence of a monotonicity guard.
     * see .claude-work/issues/offset-tracking-offsets-can-move-backwards.md
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

    test('it applies concurrent writes to separate trackers without losing any of them', async () => {
        // given
        const keys = Array.from({length: 8}, (_value, index) => uniqueKey(`parallel-${index}`));

        // when
        await Promise.all(keys.map((key, index) => repository.store(key, index + 1)));

        // then
        for (const [index, key] of keys.entries()) {
            expect(await repository.retrieve(key)).toBe(index + 1);
        }
    });

    test('it settles concurrent writes to the same tracker on the last issued offset', async () => {
        // given
        const key = uniqueKey('same-tracker-parallel');

        // when
        await Promise.all([repository.store(key, 1), repository.store(key, 2), repository.store(key, 3)]);

        // then
        expect(await repository.retrieve(key)).toBe(3);
    });
});

describe('OffsetRepositoryUsingPg', () => {
    let repository: OffsetRepository;

    beforeEach(() => {
        repository = new OffsetRepositoryUsingPg<number>(asyncPool, {tableName, consumerName});
    });

    test('it commits an offset stored outside of a transaction immediately', async () => {
        // given
        const key = uniqueKey('autocommit');

        // when
        await repository.store(key, 12);

        // then
        expect(await storedOffsetOutsideTheAsyncPool(key)).toBe(12);
    });

    test('it only publishes an offset stored inside a transaction once that transaction commits', async () => {
        // given
        const key = uniqueKey('transaction-commit');

        // when
        await asyncPool.runInTransaction(async () => {
            await repository.store(key, 33);

            // then, while the transaction is still open, no other connection sees the offset
            expect(await storedOffsetOutsideTheAsyncPool(key)).toBeUndefined();
        });

        // then
        expect(await storedOffsetOutsideTheAsyncPool(key)).toBe(33);
    });

    test('it discards a stored offset when the surrounding transaction rolls back', async () => {
        // given
        const key = uniqueKey('transaction-rollback');
        await repository.store(key, 5);

        // when
        const failingBatch = asyncPool.runInTransaction(async () => {
            await repository.store(key, 6);
            throw new Error('the batch this offset accounts for failed');
        });

        // then
        await expect(failingBatch).rejects.toThrow('the batch this offset accounts for failed');
        expect(await repository.retrieve(key)).toBe(5);
        expect(await storedOffsetOutsideTheAsyncPool(key)).toBe(5);
    });

    test('it reads back an offset written earlier in the same transaction', async () => {
        // given
        const key = uniqueKey('read-your-writes');

        // when
        await asyncPool.runInTransaction(async () => {
            await repository.store(key, 9);

            // then
            expect(await repository.retrieve(key)).toBe(9);
        });
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

    test('it rejects offsets the column cannot represent', async () => {
        // given
        const key = uniqueKey('non-integer');

        // then
        await expect(repository.store(key, 1.5)).rejects.toThrow();
        await expect(repository.store(key, Number.NaN)).rejects.toThrow();
        await expect(repository.store(key, Number.POSITIVE_INFINITY)).rejects.toThrow();
        expect(await repository.retrieve(key)).toBeUndefined();
    });

    test('it rejects reads and writes when the offsets table does not exist', async () => {
        // given
        const missing = new OffsetRepositoryUsingPg<number>(asyncPool, {
            tableName: 'test_offsets_absent',
            consumerName,
        });

        // then
        await expect(missing.retrieve(identifier)).rejects.toThrow(/test_offsets_absent/);
        await expect(missing.store(identifier, 1)).rejects.toThrow(/test_offsets_absent/);
    });

    test('it rejects further use once the pool context has been flushed', async () => {
        // given
        await repository.store(uniqueKey('before-flush'), 1);
        await asyncPool.flush();

        // then
        await expect(repository.retrieve(identifier)).rejects.toThrow(/already flushed/);
        await expect(repository.store(identifier, 1)).rejects.toThrow(/already flushed/);
    });

    test('it tolerates a second flush of the same pool context', async () => {
        // given
        await repository.store(uniqueKey('double-flush'), 1);

        // when
        await asyncPool.flush();

        // then
        await expect(asyncPool.flush()).resolves.toBeUndefined();
    });

    test('it rejects when the underlying connection pool is closed', async () => {
        // given
        const closedPool = new Pool(pgTestCredentials);
        await closedPool.end();
        const detached = new OffsetRepositoryUsingPg<number>(new AsyncPgPool(closedPool), {
            tableName,
            consumerName,
        });

        // then
        await expect(detached.retrieve(identifier)).rejects.toThrow();
        await expect(detached.store(identifier, 1)).rejects.toThrow();
    });

    /**
     * Two projector instances advancing the same tracker. Without a working row lock the
     * read-modify-write cycle loses one of the two increments.
     * see .claude-work/issues/offset-tracking-select-for-update-is-invalid-sql.md
     */
    test('it loses one increment when two isolated read-modify-write cycles interleave', async () => {
        // given
        const key = uniqueKey('lost-update');
        await repository.store(key, 0);
        let arrived = 0;
        const {promise: bothHaveRead, resolve: allArrived} = Promise.withResolvers<void>();
        const waitForBothReads = async (): Promise<void> => {
            if (++arrived === 2) {
                allArrived();
            }

            return bothHaveRead;
        };
        const advance = () =>
            asyncPool.runInIsolation(async () => {
                const current = (await repository.retrieve(key)) ?? 0;
                await waitForBothReads();
                await repository.store(key, current + 1);
            });

        // when
        await Promise.all([advance(), advance()]);

        // then, both cycles read 0 and both wrote 1 — one event batch is now unaccounted for
        expect(await repository.retrieve(key)).toBe(1);
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

describe('OffsetRepositoryUsingPg with bigint offsets', () => {
    test('it round-trips offsets beyond the safe integer range when offsets are typed as strings', async () => {
        // given
        const repository = new OffsetRepositoryUsingPg<string>(asyncPool, {
            tableName: bigintTableName,
            consumerName,
        });
        const key = uniqueKey('bigint-string');

        // when
        await repository.store(key, '9007199254740993');

        // then
        expect(await repository.retrieve(key)).toBe('9007199254740993');
        expect(await storedOffsetOutsideTheAsyncPool(key, consumerName, bigintTableName)).toBe('9007199254740993');
    });

    // see .claude-work/issues/offset-tracking-bigint-offsets-are-returned-as-strings.md
    it.fails('it returns a number for a bigint column when offsets are typed as numbers', async () => {
        // given
        const repository = new OffsetRepositoryUsingPg<number>(asyncPool, {
            tableName: bigintTableName,
            consumerName,
        });
        const key = uniqueKey('bigint-number');
        await repository.store(key, 10);

        // when
        const offset = (await repository.retrieve(key)) ?? 0;

        // then advancing the bookmark by one must yield the next offset
        expect(typeof offset).toBe('number');
        expect(offset + 1).toBe(11);
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

    // see .claude-work/issues/offset-tracking-memory-accepts-offsets-postgres-rejects.md
    it.fails('it rejects an offset that is not a finite integer', async () => {
        // given
        const repository = new OffsetRepositoryUsingMemory();

        // then
        await expect(repository.store(identifier, Number.NaN)).rejects.toThrow();
    });
});
