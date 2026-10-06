export interface MessageDeliveryCounter<Key> {
    /**
     * Counts one more failed delivery of the message and returns how many there have been.
     */
    increment(key: Key): Promise<number>;
    /**
     * Drops the count of a message that needs no more deliveries: it was handled, or it was
     * dead-lettered. Optional, so counters written before it existed keep working; without it a
     * count is kept for as long as the counter lives.
     */
    forget?(key: Key): Promise<void>;
}

export class MessageDeliveryCounterUsingMemory<Key> implements MessageDeliveryCounter<Key> {
    private readonly counts: Map<Key, number> = new Map();

    async increment(key: Key): Promise<number> {
        const count = (this.counts.get(key) ?? 0) + 1;
        this.counts.set(key, count);

        return count;
    }

    async forget(key: Key): Promise<void> {
        this.counts.delete(key);
    }
}
