import {
    type IdConversion,
    type IdFactory,
    NoIdConversion,
    type PrefixedId,
    PrefixedBrandedIdConversion,
    PrefixedBrandedIdGenerator,
    prefixedIdValidator,
} from './index.js';
import {v7 as uuidV7, validate as isValidUuid} from 'uuid';

type PersonId = PrefixedId<'person'>;
type OrderId = PrefixedId<'order'>;

const sequentialFactory = (): IdFactory<string> => {
    let sequence = 0;

    return () => `${++sequence}`;
};

/**
 * Mirrors a consumer that stores prefixed ids in an integer primary key column.
 */
class SerialIdConversion implements IdConversion<string, number> {
    fromDatabase(to: number): string {
        return `${to}`;
    }

    toDatabase(from: string): number {
        return Number.parseInt(from, 10);
    }
}

describe('PrefixedBrandedIdGenerator', () => {
    test('it prefixes every generated id with the configured prefix', () => {
        const generator = new PrefixedBrandedIdGenerator('person', sequentialFactory());

        expect(generator.generateId()).toBe('person_1');
        expect(generator.generateId()).toBe('person_2');
    });

    test('it generates a distinct id on every call', () => {
        const generator = new PrefixedBrandedIdGenerator('person', uuidV7);
        const ids = new Set(Array.from({length: 10_000}, () => generator.generateId()));

        expect(ids.size).toBe(10_000);
    });

    test('it calls the id factory without arguments', () => {
        // ULID and UUID factories accept an optional seed time as their first argument,
        // so passing anything at all would silently change the generated ids.
        const seenArgumentCounts: number[] = [];
        const factory: IdFactory<string> = function (...args: unknown[]): string {
            seenArgumentCounts.push(args.length);

            return 'id';
        };
        const generator = new PrefixedBrandedIdGenerator('person', factory);

        generator.generateId();
        generator.generateId();

        expect(seenArgumentCounts).toEqual([0, 0]);
    });

    test('it supports prefixes that contain the separator', () => {
        const generator = new PrefixedBrandedIdGenerator('order_line', sequentialFactory());

        expect(generator.generateId()).toBe('order_line_1');
    });

    test('it does not alter the id produced by the factory', () => {
        const uuid = uuidV7();
        const generator = new PrefixedBrandedIdGenerator('person', () => uuid);

        expect(generator.generateId()).toBe(`person_${uuid}`);
    });
});

describe('NoIdConversion', () => {
    test('it passes string ids through unchanged', () => {
        const conversion = new NoIdConversion<string>();
        const uuid = uuidV7();

        expect(conversion.toDatabase(uuid)).toBe(uuid);
        expect(conversion.fromDatabase(uuid)).toBe(uuid);
    });

    test('it passes numeric ids through unchanged', () => {
        const conversion = new NoIdConversion<number>();

        expect(conversion.toDatabase(0)).toBe(0);
        expect(conversion.fromDatabase(-1)).toBe(-1);
        expect(conversion.toDatabase(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    });
});

describe('PrefixedBrandedIdConversion', () => {
    const generator = new PrefixedBrandedIdGenerator('person', uuidV7);
    const conversion = new PrefixedBrandedIdConversion('person', new NoIdConversion<string>());

    test('it strips the prefix when writing to the database', () => {
        const uuid = uuidV7();

        expect(conversion.toDatabase(`person_${uuid}` as PersonId)).toBe(uuid);
    });

    test('it restores the prefix when reading from the database', () => {
        const uuid = uuidV7();

        expect(conversion.fromDatabase(uuid)).toBe(`person_${uuid}`);
    });

    test('it round-trips generated ids through the database representation', () => {
        for (let index = 0; index < 100; index++) {
            const id = generator.generateId();

            expect(conversion.fromDatabase(conversion.toDatabase(id))).toBe(id);
        }
    });

    test('it strips prefixes that contain the separator', () => {
        const orderLineIds = new PrefixedBrandedIdGenerator('order_line', uuidV7);
        const orderLineConversion = new PrefixedBrandedIdConversion('order_line', new NoIdConversion<string>());
        const id = orderLineIds.generateId();

        expect(orderLineConversion.toDatabase(id)).toBe(id.substring('order_line_'.length));
        expect(orderLineConversion.fromDatabase(orderLineConversion.toDatabase(id))).toBe(id);
    });

    test('it delegates the database representation to the nested conversion', () => {
        const serialConversion = new PrefixedBrandedIdConversion('invoice', new SerialIdConversion());

        expect(serialConversion.toDatabase('invoice_42' as PrefixedId<'invoice'>)).toBe(42);
        expect(serialConversion.fromDatabase(42)).toBe('invoice_42');
    });

    // see .claude-work/issues/uid-conversion-methods-are-not-bound.md
    it.fails('it exposes conversion methods that can be passed as standalone callbacks', () => {
        const ids = [generator.generateId(), generator.generateId()];

        const databaseValues = ids.map(conversion.toDatabase);

        expect(databaseValues).toEqual(ids.map(id => id.substring('person_'.length)));
    });

    // see .claude-work/issues/uid-conversion-silently-truncates-foreign-prefixes.md
    it.fails('it rejects ids that do not carry the configured prefix', () => {
        const orderIds = new PrefixedBrandedIdGenerator('order', uuidV7);
        const foreignId = orderIds.generateId() as unknown as PersonId;

        expect(() => conversion.toDatabase(foreignId)).toThrow();
    });
});

describe('prefixedIdValidator', () => {
    // A validator that only returns a boolean cannot be handed to prefixedIdValidator today,
    // see .claude-work/issues/uid-validator-interface-rejects-plain-predicates.md
    const isUuid = (id: unknown): id is string => typeof id === 'string' && isValidUuid(id);
    const isPersonId = prefixedIdValidator('person', isUuid);
    const uuid = uuidV7();

    test.each<[string, unknown, boolean]>([
        ['a generated id', `person_${uuid}`, true],
        ['an id of another entity', `order_${uuid}`, false],
        ['an id whose prefix is a prefix of the expected one', `perso_${uuid}`, false],
        ['an id whose prefix extends the expected one', `personal_${uuid}`, false],
        ['an id without a separator', `person${uuid}`, false],
        ['an id with the prefix repeated', `person_person_${uuid}`, false],
        ['an id with the prefix in upper case', `PERSON_${uuid}`, false],
        ['an unprefixed id', uuid, false],
        ['the prefix on its own', 'person_', false],
        ['an empty string', '', false],
        ['a blank string', '   ', false],
        ['a padded id', ` person_${uuid} `, false],
        ['an id with a trailing newline', `person_${uuid}\n`, false],
        ['an id embedded in a longer string', `id=person_${uuid}&other=1`, false],
        ['an id with a trailing null byte', `person_${uuid}` + String.fromCodePoint(0), false],
        ['a number', 42, false],
        ['null', null, false],
        ['undefined', undefined, false],
        ['an object', {}, false],
        ['an object that stringifies to a valid id', {toString: () => `person_${uuid}`}, false],
        ['an array containing a valid id', [`person_${uuid}`], false],
        ['a boolean', true, false],
    ])('it validates %s', (_description, candidate, expected) => {
        expect(isPersonId(candidate)).toBe(expected);
    });

    test('it narrows unknown input to a prefixed id', () => {
        const candidate: unknown = `person_${uuid}`;

        if (!isPersonId(candidate)) {
            throw new Error('expected the candidate to be recognised as a person id');
        }

        const conversion = new PrefixedBrandedIdConversion('person', new NoIdConversion<string>());

        expect(conversion.toDatabase(candidate)).toBe(uuid);
    });

    test('it needs a type guard rather than a plain predicate', () => {
        // The README composes prefixedIdValidator with uuid's validate, which only returns a
        // boolean. That does not satisfy IdValidator, so the documented usage does not compile.
        // see .claude-work/issues/uid-validator-interface-rejects-plain-predicates.md
        // @ts-expect-error a plain predicate is not accepted as an IdValidator
        const isPersonIdByPlainPredicate = prefixedIdValidator('person', isValidUuid);

        expect(isPersonIdByPlainPredicate(`person_${uuid}`)).toBe(true);
    });

    test('it does not accept an id that only satisfies the nested validator', () => {
        const isNever = (id: unknown): id is string => typeof id === 'string' && id === 'never';

        expect(prefixedIdValidator('person', isNever)(`person_${uuid}`)).toBe(false);
        expect(prefixedIdValidator('person', isNever)('person_never')).toBe(true);
    });
});

describe('branded prefixed ids', () => {
    test('an id of one prefix is not assignable to another prefix', () => {
        const personId: PersonId = new PrefixedBrandedIdGenerator('person', uuidV7).generateId();

        // @ts-expect-error a person id must never satisfy an order id
        const orderId: OrderId = personId;

        expect(orderId).toBe(personId);
    });

    test('an unvetted string is not assignable to a prefixed id', () => {
        // @ts-expect-error strings have to be validated before they can be used as a prefixed id
        const personId: PersonId = `person_${uuidV7()}`;

        expect(typeof personId).toBe('string');
    });
});
