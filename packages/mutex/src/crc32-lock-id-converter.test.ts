import {Crc32LockIdConverter} from './crc32-lock-id-converter.js';

const lockRange = {base: 1_000_000, range: 999_999};

describe('Crc32LockIdConverter', () => {
    const converter = new Crc32LockIdConverter(lockRange);

    test('every advisory id stays inside the configured range', () => {
        const names = ['', 'a', 'order-123', 'x'.repeat(10_000), 'naïve-🔒', '__proto__', 'ORDER-123'];

        for (const name of names) {
            const converted = converter.convert(name);

            expect(Number.isSafeInteger(converted)).toEqual(true);
            expect(converted).toBeGreaterThanOrEqual(lockRange.base);
            expect(converted).toBeLessThan(lockRange.base + lockRange.range);
        }
    });

});
