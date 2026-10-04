import {readFileSync} from 'node:fs';
import ts from 'typescript';
import type {Branded} from './index.js';
import * as brandedModule from './index.js';

/**
 * `Branded` has no runtime surface, so the meaningful assertions in this file are
 * compile-time ones. They are verified by `tsc --noEmit -p tsconfig.json`, which
 * covers `packages/**\/*.ts`:
 *
 * - a positive assertion is an assignment/call that must compile;
 * - a negative assertion is a `@ts-expect-error`, which makes `tsc` fail when the
 *   line it guards stops being an error.
 *
 * Every test also carries a runtime assertion, both to keep vitest meaningful and
 * to pin down that a branded value is nothing but its underlying value.
 */

type UserId = Branded<string, 'UserId'>;
type OrderId = Branded<string, 'OrderId'>;
type Cents = Branded<number, 'Cents'>;
type ValidatedPayload = Branded<{name: string}, 'ValidatedPayload'>;

/**
 * Copied from `@deltic/uid` (`PrefixedId`) rather than imported, so this package keeps
 * no dependency on its consumer. It is the only branding pattern used in this repository.
 */
type PrefixedId<Prefix extends string> = Branded<`${Prefix}_${string}`, Prefix>;
type PersonId = PrefixedId<'person'>;

describe('branded', () => {
    describe('nominal typing over a shared base type', () => {
        test('accepts a branded value wherever the base type is expected', () => {
            const userId = 'user_1' as UserId;
            const stored: string = userId;
            const length: number = userId.length;

            expect(stored).toBe('user_1');
            expect(length).toBe(6);
        });

        test('refuses the bare base type where a branded value is expected', () => {
            // @ts-expect-error an unvetted string is not a UserId
            const userId: UserId = 'user_1';

            expect(userId).toBe('user_1');
        });

        test('refuses a value carrying a different brand over the same base type', () => {
            const userId = 'user_1' as UserId;
            const orderId = 'order_1' as OrderId;

            // @ts-expect-error a UserId is not an OrderId
            const orderIdFromUser: OrderId = userId;
            // @ts-expect-error ... and an OrderId is not a UserId either
            const userIdFromOrder: UserId = orderId;

            expect(orderIdFromUser).toBe('user_1');
            expect(userIdFromOrder).toBe('order_1');
        });

        test('keeps the members of the base type available', () => {
            // This is what PrefixedBrandedIdConversion.toDatabase in @deltic/uid relies on.
            const personId = 'person_01HQ' as PersonId;

            const withoutPrefix: string = personId.substring('person_'.length);

            expect(withoutPrefix).toBe('01HQ');
            expect(personId.startsWith('person_')).toBe(true);
        });

        test('drops the brand as soon as the underlying value is transformed', () => {
            const userId = 'user_1' as UserId;

            // @ts-expect-error string operations return the unbranded base type
            const upperCased: UserId = userId.toUpperCase();

            expect(upperCased).toBe('USER_1');
        });

        test('drops the brand of a number under arithmetic', () => {
            const price = 1000 as Cents;
            const shipping = 250 as Cents;

            // @ts-expect-error adding two Cents yields a plain number, which needs re-branding
            const total: Cents = price + shipping;

            expect(total).toBe(1250);
        });
    });

    describe('creating branded values', () => {
        test('refuses to brand a value through satisfies, leaving the cast as the only shortcut', () => {
            // @ts-expect-error satisfies enforces the brand, so an unvetted literal is refused
            const userId = 'user_1' satisfies UserId;

            expect(userId).toBe('user_1');
        });

        test('cannot express the brand by hand because its key is a module-private symbol', () => {
            // @ts-expect-error the brand property is unspellable outside this package
            const payload: ValidatedPayload = {name: 'alice'};

            expect(payload).toEqual({name: 'alice'});
        });

        test('checks the underlying value when branding happens behind a factory', () => {
            const asPersonId = (value: `person_${string}`): PersonId => value as PersonId;

            // @ts-expect-error the factory boundary still checks the shape a bare cast would let through
            asPersonId('order_1');

            expect(asPersonId('person_01HQ')).toBe('person_01HQ');
        });

        test('narrows an unvetted value through a validating type guard', () => {
            // The shape of prefixedIdValidator in @deltic/uid.
            const isPersonId = (value: unknown): value is PersonId =>
                typeof value === 'string' && value.startsWith('person_');
            const incoming: unknown = 'person_01HQ';
            let personId: PersonId | undefined;

            if (isPersonId(incoming)) {
                personId = incoming;
            }

            expect(personId).toBe('person_01HQ');
            expect(isPersonId('order_1')).toBe(false);
            expect(isPersonId(42)).toBe(false);
        });
    });

    describe('composition with other types', () => {
        test('keeps the brand on the elements of a collection', () => {
            // @ts-expect-error the elements of a branded array are branded too
            const unvetted: UserId[] = ['user_1'];
            const userIds: UserId[] = ['user_1' as UserId];

            // @ts-expect-error looking up an unvetted string in a branded collection is a mistake
            userIds.includes('user_1');

            expect(unvetted).toEqual(userIds);
        });

        test('keeps the brand on optional properties of a partial update', () => {
            interface User {
                id: UserId;
                email: string;
            }

            // @ts-expect-error Partial makes the property optional, not unbranded
            const patch: Partial<User> = {id: 'user_1'};

            expect(patch).toEqual({id: 'user_1'});
        });

        test('carries the brand through a generic function', () => {
            const firstOf = <T>(items: T[]): T => items[0]!;
            const userIds = ['user_1' as UserId];

            const userId: UserId = firstOf(userIds);
            // @ts-expect-error the inferred UserId is still not an OrderId
            const orderId: OrderId = firstOf(userIds);

            expect(userId).toBe(orderId);
        });

        test('carries the brand through a promise', async () => {
            const loadUserId = async (): Promise<UserId> => 'user_1' as UserId;

            const userId: UserId = await loadUserId();
            // @ts-expect-error awaiting does not remove the brand
            const orderId: OrderId = await loadUserId();

            expect(userId).toBe(orderId);
        });

        test('keeps the brand on the keys of a lookup record', () => {
            const userId = 'user_1' as UserId;
            const namesById: Record<UserId, string> = {} as Record<UserId, string>;
            const unvetted: string = 'user_2';

            namesById[userId] = 'alice';
            // @ts-expect-error an unvetted key may not be used to index a branded record
            namesById[unvetted] = 'bob';

            expect(namesById[userId]).toBe('alice');
            expect(Object.keys(namesById)).toEqual(['user_1', 'user_2']);
        });

        test('requires a union of two brands to be narrowed before use', () => {
            const identify = (id: UserId | OrderId): string => {
                // @ts-expect-error the union has to be narrowed before it is either brand
                const userId: UserId = id;

                return userId;
            };

            expect(identify('user_1' as UserId)).toBe('user_1');
        });

        test('keeps the brand when the value is optional', () => {
            const missing: UserId | undefined = undefined;
            // @ts-expect-error nullability does not weaken the brand
            const unvetted: UserId | undefined = 'user_1';

            expect(missing).toBeUndefined();
            expect(unvetted).toBe('user_1');
        });

        test('accepts any branded string where the brand itself is left open', () => {
            // The shape of a generic id-to-database conversion: it accepts vetted ids of any brand.
            const toDatabaseValue = (id: Branded<string, string>): string => id;

            // @ts-expect-error an unbranded string is still refused
            toDatabaseValue('user_1');

            expect(toDatabaseValue('user_1' as UserId)).toBe('user_1');
            expect(toDatabaseValue('order_1' as OrderId)).toBe('order_1');
        });

        test('gives up the brand in a union with its own base type', () => {
            // A cautionary case: this signature accepts every string, so the brand buys nothing.
            const lookUp = (id: UserId | string): string => id;

            expect(lookUp('anything at all')).toBe('anything at all');
            expect(lookUp('user_1' as UserId)).toBe('user_1');
        });
    });

    describe('the prefixed id pattern of @deltic/uid', () => {
        test('accepts a prefixed id where its template literal base is expected', () => {
            const personId = 'person_01HQ' as PersonId;

            const raw: `person_${string}` = personId;
            // @ts-expect-error the template literal on its own carries no brand
            const branded: PersonId = raw;

            expect(raw).toBe(branded);
        });

        test('refuses an id generated for a different prefix', () => {
            const generateId = <Prefix extends string>(
                prefix: Prefix,
                unique: () => string,
            ): PrefixedId<Prefix> => `${prefix}_${unique()}` as PrefixedId<Prefix>;

            const personId: PersonId = generateId('person', () => '01HQ');
            // @ts-expect-error the prefix determines the brand, so this is not an order id
            const orderId: PrefixedId<'order'> = generateId('person', () => '01HQ');

            expect(personId).toBe('person_01HQ');
            expect(orderId).toBe('person_01HQ');
        });

        test('round-trips a prefixed id through a database conversion', () => {
            const toDatabase = (id: PersonId): string => id.substring('person_'.length);
            const fromDatabase = (value: string): PersonId => `person_${value}` as PersonId;

            // @ts-expect-error the database representation is not a vetted id
            toDatabase('person_01HQ');

            expect(toDatabase('person_01HQ' as PersonId)).toBe('01HQ');
            expect(fromDatabase('01HQ')).toBe('person_01HQ');
        });
    });

    describe('runtime footprint', () => {
        test('adds nothing observable to a branded value', () => {
            const payload = {name: 'alice'} as ValidatedPayload;

            expect(Object.keys(payload)).toEqual(['name']);
            expect(Object.getOwnPropertySymbols(payload)).toEqual([]);
            expect(JSON.stringify(payload)).toBe('{"name":"alice"}');
        });

        test('leaves a branded primitive indistinguishable from its base value', () => {
            const userId = 'user_1' as UserId;
            const cents = 1000 as Cents;

            expect(typeof userId).toBe('string');
            expect(typeof cents).toBe('number');
            expect(userId).toBe('user_1');
            expect(JSON.stringify({id: userId, amount: cents})).toBe('{"id":"user_1","amount":1000}');
        });

        test('exports nothing at runtime, so the brand cannot be reached or forged', () => {
            expect(Object.keys(brandedModule)).toEqual([]);
        });
    });

    describe('layering a second brand onto an already branded type', () => {
        // see .claude-work/issues/branded-nested-brands-collapse-to-never.md
        it.fails('yields an inhabitable type when a refinement brand is layered on', () => {
            expect(typeErrorsIn(`
                type UserId = Branded<string, 'UserId'>;
                type Verified<T> = Branded<T, 'Verified'>;
                type IsNever<T> = [T] extends [never] ? true : false;

                // Refuses to compile for as long as Verified<UserId> collapses to never.
                const layeredBrandIsInhabitable: IsNever<Verified<UserId>> = false;
            `)).toEqual([]);
        });

        // see .claude-work/issues/branded-nested-brands-collapse-to-never.md
        it.fails('keeps a doubly branded value out of an unrelated brand', () => {
            const errors = typeErrorsIn(`
                type UserId = Branded<string, 'UserId'>;
                type OrderId = Branded<string, 'OrderId'>;
                type Verified<T> = Branded<T, 'Verified'>;

                declare const verified: Verified<UserId>;
                const orderId: OrderId = verified;
            `);

            expect(errors.length).toBeGreaterThan(0);
        });
    });
});

/**
 * Type-checks a snippet against the real `Branded` definition and returns the type errors
 * it produces. The repository-wide `tsc` run cannot express "this should be an error but is
 * not yet", which is exactly what the `it.fails` assertions above need.
 */
function typeErrorsIn(scenario: string): string[] {
    const compilerOptions: ts.CompilerOptions = {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
    const sources = new Map<string, string>([
        ['/branded.ts', readFileSync(new URL('index.ts', import.meta.url), 'utf8')],
        ['/scenario.ts', `import type {Branded} from './branded';\n${scenario}`],
    ]);
    const host = ts.createCompilerHost(compilerOptions, true);
    const readHostFile = host.readFile.bind(host);
    const readHostSourceFile = host.getSourceFile.bind(host);
    const hostFileExists = host.fileExists.bind(host);

    host.fileExists = fileName => sources.has(fileName) || hostFileExists(fileName);
    host.readFile = fileName => sources.get(fileName) ?? readHostFile(fileName);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
        const source = sources.get(fileName);

        return source === undefined
            ? readHostSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
            : ts.createSourceFile(fileName, source, languageVersion);
    };

    const program = ts.createProgram(['/scenario.ts'], compilerOptions, host);

    return program
        .getSemanticDiagnostics(program.getSourceFile('/scenario.ts'))
        .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
}
