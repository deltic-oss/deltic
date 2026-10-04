import {NoIdConversion, PrefixedBrandedIdConversion} from './index.js';
import {UlidToUuidIdConversion, isValidUlid, ulidPrefixedBrandedIdGenerator} from './ulid.js';
import {MAX_ULID, MIN_ULID, decodeTime} from 'ulid';
import {v7 as uuidV7} from 'uuid';

const PREFIX = 'order';
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const EXAMPLE_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const LARGEST_ENCODABLE_TIME = 281_474_976_710_655;

const generator = ulidPrefixedBrandedIdGenerator(PREFIX);
const ulidOf = (id: string): string => id.substring(PREFIX.length + 1);
const lexicographically = (left: string, right: string): number => {
    if (left === right) {
        return 0;
    }

    return left < right ? -1 : 1;
};

const withFrozenClock = <Result>(now: number, use: () => Result): Result => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);

    try {
        return use();
    } finally {
        clock.mockRestore();
    }
};

describe('ulidPrefixedBrandedIdGenerator', () => {
    let ids: string[] = [];

    beforeAll(() => {
        ids = Array.from({length: 100_000}, () => generator.generateId());
    });

    afterAll(() => {
        ids = [];
    });

    test('it generates prefixed ulids', () => {
        const id = generator.generateId();

        expect(id.startsWith('order_')).toBe(true);
        expect(isValidUlid(ulidOf(id))).toBe(true);
        expect(ulidOf(id)).toHaveLength(TIME_LENGTH + RANDOM_LENGTH);
    });

    test('it generates ids of a fixed length', () => {
        // A leading zero in either the time or the random part must not shorten the id.
        const lengths = new Set(ids.map(id => id.length));

        expect([...lengths]).toEqual(['order_'.length + TIME_LENGTH + RANDOM_LENGTH]);
    });

    test('it only uses the unambiguous Crockford base32 alphabet', () => {
        const used = new Set<string>();

        for (const id of ids) {
            for (const character of ulidOf(id)) {
                used.add(character);
            }
        }

        for (const character of used) {
            expect(CROCKFORD_ALPHABET).toContain(character);
        }

        for (const ambiguous of ['I', 'L', 'O', 'U']) {
            expect(used.has(ambiguous)).toBe(false);
        }
    });

    test('it generates ids that are safe to use in urls and file names', () => {
        for (const id of ids.slice(0, 5_000)) {
            expect(id).toMatch(/^order_[0-9A-Z]{26}$/);
            expect(encodeURIComponent(id)).toBe(id);
        }
    });

    test('it generates a hundred thousand distinct ids', () => {
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('it spreads the random part over the whole alphabet', () => {
        const occurrences = new Map<string, number>();

        for (const id of ids) {
            for (const character of ulidOf(id).substring(TIME_LENGTH)) {
                occurrences.set(character, (occurrences.get(character) ?? 0) + 1);
            }
        }

        const total = ids.length * RANDOM_LENGTH;

        expect(occurrences.size).toBe(CROCKFORD_ALPHABET.length);

        // A uniform distribution would give every character 3.125%. The bounds are wide
        // enough to absorb both sampling noise and the rounding skew of the encoder,
        // but tight enough to catch a collapse of the entropy source.
        for (const character of CROCKFORD_ALPHABET) {
            const share = (occurrences.get(character) ?? 0) / total;

            expect(share).toBeGreaterThan(0.024);
            expect(share).toBeLessThan(0.040);
        }
    });

    test('it draws its entropy from the platform CSPRNG', () => {
        // The uuid package caches its reference to crypto.getRandomValues on first use.
        // Draw one uuid before installing the spy so that cache can never capture it:
        // the suite runs with isolate: false, so module state is shared between files.
        uuidV7();
        const getRandomValues = vi.spyOn(globalThis.crypto, 'getRandomValues');

        try {
            const id = generator.generateId();

            expect(getRandomValues).toHaveBeenCalled();
            expect(isValidUlid(ulidOf(id))).toBe(true);
        } finally {
            getRandomValues.mockRestore();
        }
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

    test('ids generated within a single millisecond share the same time component', () => {
        const burst = withFrozenClock(1_700_000_000_000, () => Array.from({length: 100}, () => generator.generateId()));
        const timeComponents = new Set(burst.map(id => ulidOf(id).substring(0, TIME_LENGTH)));

        expect([...timeComponents]).toEqual(['01HF7YAT00']);
        expect(new Set(burst).size).toBe(burst.length);
    });

    test('ids generated in later milliseconds sort after earlier ones', () => {
        const first = withFrozenClock(1_700_000_000_000, () => generator.generateId());
        const second = withFrozenClock(1_700_000_000_001, () => generator.generateId());
        const third = withFrozenClock(1_700_000_060_000, () => generator.generateId());
        const chronological = [first, second, third];

        expect([...chronological].sort(lexicographically)).toEqual(chronological);
    });

    // see .claude-work/issues/uid-ulid-generator-is-not-monotonic.md
    test('the ordering of ids generated within a single millisecond is not guaranteed', () => {
        const burst = withFrozenClock(1_700_000_000_000, () => Array.from({length: 200}, () => generator.generateId()));

        expect([...burst].sort(lexicographically)).not.toEqual(burst);
    });

    // see .claude-work/issues/uid-ulid-generator-is-not-monotonic.md
    test('ids generated after a backwards clock adjustment sort before earlier ids', () => {
        const beforeAdjustment = withFrozenClock(1_700_000_060_000, () => generator.generateId());
        const afterAdjustment = withFrozenClock(1_700_000_000_000, () => generator.generateId());

        expect(afterAdjustment < beforeAdjustment).toBe(true);
    });
});

describe('isValidUlid', () => {
    test.each<[string, unknown, boolean]>([
        ['a generated ulid', EXAMPLE_ULID, true],
        ['the lower case form of a ulid', EXAMPLE_ULID.toLowerCase(), true],
        ['the smallest ulid', MIN_ULID, true],
        ['the largest ulid', MAX_ULID, true],
        ['a ulid that is one character short', EXAMPLE_ULID.substring(1), false],
        ['a ulid with a character appended', `${EXAMPLE_ULID}0`, false],
        ['a ulid containing the ambiguous I', `I${EXAMPLE_ULID.substring(1)}`, false],
        ['a ulid containing the ambiguous L', `L${EXAMPLE_ULID.substring(1)}`, false],
        ['a ulid containing the ambiguous O', `O${EXAMPLE_ULID.substring(1)}`, false],
        ['a ulid containing the ambiguous U', `${EXAMPLE_ULID.substring(0, 25)}U`, false],
        ['a hyphenated ulid', `${EXAMPLE_ULID.substring(0, 10)}-${EXAMPLE_ULID.substring(11)}`, false],
        ['an empty string', '', false],
        ['a blank string of the right length', ' '.repeat(26), false],
        ['a padded ulid', ` ${EXAMPLE_ULID} `, false],
        ['a ulid with a trailing newline', `${EXAMPLE_ULID}\n`, false],
        ['a uuid', '019fcd60-3ccd-7153-976f-416dbb2a3a08', false],
        ['a prefixed ulid', `order_${EXAMPLE_ULID}`, false],
        ['a number', 42, false],
        ['null', null, false],
        ['undefined', undefined, false],
        ['an object', {}, false],
        ['an object that stringifies to a ulid', {toString: () => EXAMPLE_ULID}, false],
    ])('it validates %s', (_description, candidate, expected) => {
        expect(isValidUlid(candidate)).toBe(expected);
    });

    // see .claude-work/issues/uid-ulid-validator-accepts-unconvertible-ids.md
    it.fails('it rejects ulids whose time component exceeds the largest encodable time', () => {
        expect(isValidUlid('8ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false);
        expect(isValidUlid('ZZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false);
    });

    // see .claude-work/issues/uid-ulid-validator-accepts-unconvertible-ids.md
    test('the conversion rejects ulids that the validator accepts', () => {
        const conversion = new UlidToUuidIdConversion();

        expect(isValidUlid('8ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(true);
        expect(() => conversion.toDatabase('8ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toThrow('Invalid ULID');
        expect(() => decodeTime('8ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toThrow('timestamp too large');
    });
});

describe('UlidToUuidIdConversion', () => {
    const conversion = new UlidToUuidIdConversion();

    test('it round-trips generated ulids through their uuid representation', () => {
        for (let index = 0; index < 500; index++) {
            const id = ulidOf(generator.generateId());

            expect(conversion.fromDatabase(conversion.toDatabase(id))).toBe(id);
        }
    });

    test('it round-trips uuids that were written by another writer', () => {
        for (let index = 0; index < 500; index++) {
            const uuid = uuidV7();

            expect(conversion.toDatabase(conversion.fromDatabase(uuid)).toLowerCase()).toBe(uuid);
        }
    });

    test('it round-trips uuids that do not encode a ulid time component', () => {
        expect(conversion.fromDatabase('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe(MAX_ULID);
        expect(conversion.fromDatabase('00000000-0000-0000-0000-000000000000')).toBe(MIN_ULID);
        expect(conversion.toDatabase(MAX_ULID).toLowerCase()).toBe('ffffffff-ffff-ffff-ffff-ffffffffffff');
        expect(conversion.toDatabase(MIN_ULID).toLowerCase()).toBe('00000000-0000-0000-0000-000000000000');
    });

    test('it accepts the lower case uuids a database returns', () => {
        const id = ulidOf(generator.generateId());
        const databaseValue = conversion.toDatabase(id);

        expect(conversion.fromDatabase(databaseValue.toLowerCase())).toBe(id);
    });

    test('it preserves the chronological ordering of the ids', () => {
        const times = [0, 1, 1_000, 1_700_000_000_000, 2_147_483_648_000, LARGEST_ENCODABLE_TIME];
        const databaseValues = times.map(time => conversion.toDatabase(ulidOf(withFrozenClock(time, () => generator.generateId()))));

        expect([...databaseValues].sort(lexicographically)).toEqual(databaseValues);
    });

    test.each<[string, number]>([
        ['the unix epoch', 0],
        ['the first millisecond', 1],
        ['a time beyond the 32 bit second boundary', 2_147_483_648_000],
        ['a recent time', 1_700_000_000_000],
        ['the largest encodable time', LARGEST_ENCODABLE_TIME],
    ])('it preserves the timestamp of %s', (_description, msecs) => {
        const id = conversion.fromDatabase(uuidV7({msecs}));

        expect(decodeTime(id)).toBe(msecs);
    });

    test('it rejects malformed database values', () => {
        expect(() => conversion.fromDatabase('')).toThrow('Invalid UUID');
        expect(() => conversion.fromDatabase('not-a-uuid')).toThrow('Invalid UUID');
        expect(() => conversion.fromDatabase('019fcd60-3ccd-7153-976f-416dbb2a3a0')).toThrow('Invalid UUID');
        expect(() => conversion.fromDatabase(EXAMPLE_ULID)).toThrow('Invalid UUID');
    });

    test('it rejects malformed ulids', () => {
        expect(() => conversion.toDatabase('')).toThrow('Invalid ULID');
        expect(() => conversion.toDatabase(EXAMPLE_ULID.substring(1))).toThrow('Invalid ULID');
        expect(() => conversion.toDatabase(`order_${EXAMPLE_ULID}`)).toThrow('Invalid ULID');
    });

    // see .claude-work/issues/uid-ulid-to-uuid-conversion-yields-uppercase.md
    it.fails('it produces uuids in the canonical lower case form', () => {
        const databaseValue = conversion.toDatabase(ulidOf(generator.generateId()));

        expect(databaseValue).toBe(databaseValue.toLowerCase());
    });
});

describe('storing prefixed ulids in a uuid column', () => {
    const conversion = new PrefixedBrandedIdConversion(PREFIX, new UlidToUuidIdConversion());

    test('it round-trips a generated id through the database representation', () => {
        const id = generator.generateId();
        const databaseValue = conversion.toDatabase(id);

        expect(databaseValue).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
        expect(conversion.fromDatabase(databaseValue)).toBe(id);
    });

    test('it restores a prefixed id from the lower case form a database returns', () => {
        const id = generator.generateId();

        expect(conversion.fromDatabase(conversion.toDatabase(id).toLowerCase())).toBe(id);
    });

    test('the database representation preserves the chronological ordering of the ids', () => {
        const times = [1_700_000_000_000, 1_700_000_000_001, 1_700_000_060_000, 1_800_000_000_000];
        const databaseValues = times.map(time => conversion.toDatabase(withFrozenClock(time, () => generator.generateId())));

        expect([...databaseValues].sort(lexicographically)).toEqual(databaseValues);
    });

    test('a prefixed id keeps its own representation out of the database', () => {
        const id = generator.generateId();

        expect(conversion.toDatabase(id)).not.toContain(PREFIX);
        expect(conversion.toDatabase(id)).toHaveLength(36);
    });
});

describe('NoIdConversion for ulids', () => {
    test('it stores a ulid unchanged for text columns', () => {
        const conversion = new PrefixedBrandedIdConversion(PREFIX, new NoIdConversion<string>());
        const id = generator.generateId();

        expect(conversion.toDatabase(id)).toBe(ulidOf(id));
        expect(conversion.fromDatabase(conversion.toDatabase(id))).toBe(id);
    });
});
