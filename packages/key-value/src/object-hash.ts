import objectHash from 'object-hash';
import type {KeyType} from './index.js';

/**
 * Stores an object or array key as a SHA3-512 hash of its contents, and any other key as its string
 * form. A hash has a fixed length, so a key of any size fits the `key` column, but it cannot be read
 * back into the key it was made from.
 */
export function objectHashKeyConversion(key: KeyType): string {
    return typeof key === 'object' ? objectHash(key, {algorithm: 'sha3-512'}) : String(key);
}
