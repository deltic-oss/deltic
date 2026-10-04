import {Crc32LockIdConverter} from './crc32-lock-id-converter.js';

const lockRange = {base: 1_000_000, range: 999_999};

describe('Crc32LockIdConverter', () => {
    const converter = new Crc32LockIdConverter(lockRange);

    test('a lock name always converts to the same advisory id', () => {
        expect(converter.convert('order-123')).toEqual(converter.convert('order-123'));
        expect(new Crc32LockIdConverter(lockRange).convert('order-123')).toEqual(converter.convert('order-123'));
    });

    test('every advisory id stays inside the configured range', () => {
        const names = ['', 'a', 'order-123', 'x'.repeat(10_000), 'naïve-🔒', '__proto__', 'ORDER-123'];

        for (const name of names) {
            const converted = converter.convert(name);

            expect(Number.isSafeInteger(converted)).toEqual(true);
            expect(converted).toBeGreaterThanOrEqual(lockRange.base);
            expect(converted).toBeLessThan(lockRange.base + lockRange.range);
        }
    });

    test('an empty lock name converts to the base of the range', () => {
        expect(converter.convert('')).toEqual(lockRange.base);
    });

    test('lock names that differ only in case convert to different advisory ids', () => {
        expect(converter.convert('order-123')).not.toEqual(converter.convert('Order-123'));
    });

    // see .claude-work/issues/mutex-crc32-collisions-alias-unrelated-locks.md
    test('unrelated lock names can convert to the same advisory id', () => {
        const narrowConverter = new Crc32LockIdConverter({base: 0, range: 10_000});

        // two unrelated lock names that end up sharing a single advisory lock
        expect(narrowConverter.convert('order-27')).toEqual(narrowConverter.convert('order-103'));
    });

    // see .claude-work/issues/mutex-crc32-collisions-alias-unrelated-locks.md
    test('the number of distinct advisory ids is bound by the range, not by the number of lock names', () => {
        const narrowConverter = new Crc32LockIdConverter({base: 0, range: 10_000});
        const advisoryIds = new Set<number>();

        for (let index = 0; index < 5_000; index++) {
            advisoryIds.add(narrowConverter.convert(`order-${index}`));
        }

        // 5.000 unrelated lock names serialise onto far fewer locks than lock names
        expect(advisoryIds.size).toBeLessThan(4_000);
    });

    test('a range of zero cannot produce a usable advisory id', () => {
        const brokenConverter = new Crc32LockIdConverter({base: 1_000, range: 0});

        expect(Number.isNaN(brokenConverter.convert('order-123'))).toEqual(true);
    });
});
