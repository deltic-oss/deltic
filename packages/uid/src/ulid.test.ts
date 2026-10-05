import {NoIdConversion, PrefixedBrandedIdConversion} from './index.js';
import {UlidToUuidIdConversion, isValidUlid, ulidPrefixedBrandedIdGenerator} from './ulid.js';

const PREFIX = 'order';

const generator = ulidPrefixedBrandedIdGenerator(PREFIX);
const ulidOf = (id: string): string => id.substring(PREFIX.length + 1);

describe('ulidPrefixedBrandedIdGenerator', () => {
    test('it generates prefixed ulids', () => {
        const id = generator.generateId();

        expect(id.startsWith('order_')).toBe(true);
        expect(isValidUlid(ulidOf(id))).toBe(true);
    });
});

describe('UlidToUuidIdConversion', () => {
    const conversion = new UlidToUuidIdConversion();

    test('it round-trips a generated ulid through its uuid representation', () => {
        const id = ulidOf(generator.generateId());

        expect(conversion.fromDatabase(conversion.toDatabase(id))).toBe(id);
    });

});

describe('storing prefixed ulids in a uuid column', () => {
    const conversion = new PrefixedBrandedIdConversion(PREFIX, new UlidToUuidIdConversion());

    test('it round-trips a generated id through the database representation', () => {
        const id = generator.generateId();

        expect(conversion.fromDatabase(conversion.toDatabase(id))).toBe(id);
    });

    test('a prefixed id keeps its own representation out of the database', () => {
        const id = generator.generateId();

        expect(conversion.toDatabase(id)).not.toContain(PREFIX);
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
