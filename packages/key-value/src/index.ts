export type KeyType = null | object | undefined | string | number | boolean | KeyType[] | KeyObject;

export type KeyObject = {
    [index: string | number]: KeyType;
};

export interface KeyConversion<Key extends KeyType, DatabaseKey extends string | number> {
    (key: Key): DatabaseKey;
}

/**
 * Brings a key into the one form a store addresses it by, so keys that are equal as values find the
 * same entry.
 */
export interface KeyNormalisation<Key extends KeyType> {
    normalise(key: Key): Key;
}

/**
 * Sorts the properties of an object key, and of every object nested in it, so the order in which a key
 * was built does not matter. Arrays are left as they are, and so is anything other than a plain object.
 */
export class SortingKeyNormalisation<Key extends KeyType> implements KeyNormalisation<Key> {
    normalise(key: Key): Key {
        return sortProperties(key) as Key;
    }
}

function sortProperties(value: KeyType): KeyType {
    if (!isPlainObject(value)) {
        return value;
    }

    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map(name => [name, sortProperties(value[name])]),
    );
}

function isPlainObject(value: KeyType): value is KeyObject {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
}

export type ValueType = KeyType;

export interface KeyValueStore<Key extends KeyType, Value extends ValueType> {
    persist(key: Key, value: Value): Promise<void>;
    retrieve(key: Key): Promise<Value | undefined>;
    remove(key: Key): Promise<void>;
    clear(): Promise<void>;
}
