import {type KeyNormalisation, type KeyType, type KeyValueStore, SortingKeyNormalisation, type ValueType} from './index.js';

export interface KeyValueStoreUsingMemoryOptions<Key extends KeyType> {
    keyNormalisation?: KeyNormalisation<Key>;
}

export class KeyValueStoreUsingMemory<Key extends KeyType, Value extends ValueType> implements KeyValueStore<
    Key,
    Value
> {
    private storage: Map<string, Value> = new Map();
    private readonly keyNormalisation: KeyNormalisation<Key>;

    constructor(options: KeyValueStoreUsingMemoryOptions<Key> = {}) {
        this.keyNormalisation = options.keyNormalisation ?? new SortingKeyNormalisation<Key>();
    }

    async persist(key: Key, value: Value): Promise<void> {
        this.storage.set(this.resolveKey(key), value);
    }

    async retrieve(key: Key): Promise<Value | undefined> {
        return this.storage.get(this.resolveKey(key));
    }

    async remove(key: Key): Promise<void> {
        this.storage.delete(this.resolveKey(key));
    }

    resolveKey(key: Key): string {
        const normalised = this.keyNormalisation.normalise(key);

        return typeof normalised === 'object' ? JSON.stringify(normalised) : String(normalised);
    }

    async clear(): Promise<void> {
        this.storage.clear();
    }
}
