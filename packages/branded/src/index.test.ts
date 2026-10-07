import type {Branded} from './index.js';

/**
 * `Branded` has no runtime surface, so the meaningful assertions in this file are
 * compile-time ones. They are verified by `tsc --noEmit -p tsconfig.json`, which
 * covers `packages/**\/*.ts`:
 *
 * - a positive assertion is an assignment/call that must compile;
 * - a negative assertion is a `@ts-expect-error`, which makes `tsc` fail when the
 *   line it guards stops being an error.
 *
 * Every test also carries a runtime assertion, to keep vitest meaningful.
 */

type UserId = Branded<string, 'UserId'>;
type OrderId = Branded<string, 'OrderId'>;
type ValidatedPayload = Branded<{name: string}, 'ValidatedPayload'>;

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

    });

    describe('creating branded values', () => {

        test('cannot express the brand by hand because its key is a module-private symbol', () => {
            // @ts-expect-error the brand property is unspellable outside this package
            const payload: ValidatedPayload = {name: 'alice'};

            expect(payload).toEqual({name: 'alice'});
        });

    });

    describe('composition with other types', () => {

        test('accepts any branded string where the brand itself is left open', () => {
            // The shape of a generic id-to-database conversion: it accepts vetted ids of any brand.
            const toDatabaseValue = (id: Branded<string, string>): string => id;

            // @ts-expect-error an unbranded string is still refused
            toDatabaseValue('user_1');

            expect(toDatabaseValue('user_1' as UserId)).toBe('user_1');
            expect(toDatabaseValue('order_1' as OrderId)).toBe('order_1');
        });

    });

});
