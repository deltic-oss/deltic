import {NoIdConversion, PrefixedBrandedIdConversion} from './index.js';
import {uuidV7PrefixedBrandedIdGenerator} from './uuid.js';
import {parse, validate as isValidUuid, version as uuidVersion} from 'uuid';

const PREFIX = 'person';
const generator = uuidV7PrefixedBrandedIdGenerator(PREFIX);
const uuidOf = (id: string): string => id.substring(PREFIX.length + 1);
const lexicographically = (left: string, right: string): number => {
    if (left === right) {
        return 0;
    }

    return left < right ? -1 : 1;
};

/**
 * The first 48 bits of a version 7 uuid hold the generation time in milliseconds.
 */
const timestampOf = (uuid: string): number => {
    const bytes = parse(uuid);

    return bytes[0] * 2 ** 40
        + bytes[1] * 2 ** 32
        + bytes[2] * 2 ** 24
        + bytes[3] * 2 ** 16
        + bytes[4] * 2 ** 8
        + bytes[5];
};

/**
 * The 31 bit counter that keeps ids generated within a single millisecond ordered.
 */
const counterOf = (uuid: string): number => {
    const bytes = parse(uuid);

    return (bytes[6] & 0x0f) * 2 ** 28
        + bytes[7] * 2 ** 20
        + (bytes[8] & 0x3f) * 2 ** 14
        + bytes[9] * 2 ** 6
        + ((bytes[10] & 0xfc) >>> 2);
};

const withFrozenClock = <Result>(now: number, use: () => Result): Result => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);

    try {
        return use();
    } finally {
        clock.mockRestore();
    }
};

describe('uuidV7PrefixedBrandedIdGenerator', () => {
    let ids: string[] = [];

    beforeAll(() => {
        ids = Array.from({length: 100_000}, () => generator.generateId());
    });

    afterAll(() => {
        ids = [];
    });

    test('it generates prefixed version 7 uuids', () => {
        const id = generator.generateId();

        expect(id.startsWith('person_')).toBe(true);
        expect(isValidUuid(uuidOf(id))).toBe(true);
        expect(uuidVersion(uuidOf(id))).toBe(7);
    });

    test('it generates ids of a fixed length', () => {
        const lengths = new Set(ids.map(id => id.length));

        expect([...lengths]).toEqual(['person_'.length + 36]);
    });

    test('it generates ids that are safe to use in urls and file names', () => {
        for (const id of ids.slice(0, 5_000)) {
            expect(id).toMatch(/^person_[0-9a-f-]{36}$/);
            expect(encodeURIComponent(id)).toBe(id);
        }
    });

    test('it generates a hundred thousand distinct ids', () => {
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('it never draws randomness from Math.random', () => {
        const random = vi.spyOn(Math, 'random');

        try {
            for (let index = 0; index < 1_000; index++) {
                generator.generateId();
            }

            expect(random).not.toHaveBeenCalled();
        } finally {
            random.mockRestore();
        }
    });

    test('it stores the generation time in the first 48 bits', () => {
        const now = Date.now();
        const id = withFrozenClock(now, () => generator.generateId());

        expect(timestampOf(uuidOf(id))).toBe(now);
    });

    test('ids generated within a single millisecond remain strictly increasing', () => {
        const burst = withFrozenClock(Date.now(), () => Array.from({length: 10_000}, () => generator.generateId()));

        expect([...burst].sort(lexicographically)).toEqual(burst);
        expect(new Set(burst).size).toBe(burst.length);
    });

    test('consecutive ids in the same millisecond differ by a single counter increment', () => {
        // Only the trailing 40 bits are re-randomised per id: within one millisecond the
        // remainder of an id is derived from its predecessor, so these ids must never be
        // used as unguessable tokens.
        const [, second, third] = withFrozenClock(Date.now(), () => [
            generator.generateId(),
            generator.generateId(),
            generator.generateId(),
        ]);

        expect(timestampOf(uuidOf(third))).toBe(timestampOf(uuidOf(second)));
        expect(counterOf(uuidOf(third))).toBe(counterOf(uuidOf(second)) + 1);
    });

    test('ids stay ordered when the system clock jumps backwards', () => {
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);

        try {
            const beforeAdjustment = Array.from({length: 5}, () => generator.generateId());
            clock.mockReturnValue(now - 60_000);
            const afterAdjustment = Array.from({length: 5}, () => generator.generateId());
            const adjusted = [...beforeAdjustment, ...afterAdjustment];

            expect([...adjusted].sort(lexicographically)).toEqual(adjusted);
            expect(new Set(adjusted).size).toBe(adjusted.length);
        } finally {
            clock.mockRestore();
        }
    });

    test('ids from separate generators share a single ordering', () => {
        const people = uuidV7PrefixedBrandedIdGenerator('person');
        const orders = uuidV7PrefixedBrandedIdGenerator('order');
        const uuids = withFrozenClock(Date.now(), () => {
            const generated: string[] = [];

            for (let index = 0; index < 50; index++) {
                generated.push(uuidOf(people.generateId()), orders.generateId().substring('order_'.length));
            }

            return generated;
        });

        expect([...uuids].sort(lexicographically)).toEqual(uuids);
    });
});

describe('storing prefixed uuid v7 ids in a database', () => {
    const conversion = new PrefixedBrandedIdConversion(PREFIX, new NoIdConversion<string>());

    test('it round-trips a generated id through the database representation', () => {
        const id = generator.generateId();
        const databaseValue = conversion.toDatabase(id);

        expect(isValidUuid(databaseValue)).toBe(true);
        expect(conversion.fromDatabase(databaseValue)).toBe(id);
    });

    test('the database representation preserves the ordering of the ids', () => {
        const ids = withFrozenClock(Date.now(), () => Array.from({length: 1_000}, () => generator.generateId()));
        const databaseValues = ids.map(id => conversion.toDatabase(id));

        expect([...databaseValues].sort(lexicographically)).toEqual(databaseValues);
    });
});
