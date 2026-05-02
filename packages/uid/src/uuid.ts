import {PrefixedBrandedIdGenerator} from './index.js';
import {v7} from 'uuid';

export function uuidV7PrefixedBrandedIdGenerator<Prefix extends string>(
    prefix: Prefix,
): PrefixedBrandedIdGenerator<Prefix> {
    return new PrefixedBrandedIdGenerator(prefix, v7);
}
