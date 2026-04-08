import type {AnyMessageFrom} from '@deltic/messaging';
import {AggregateRootBehavior, type AggregateRootFactory, type AggregateStream} from '@deltic/event-sourcing';
import type {
    AggregateRootFactoryWithSnapshotting,
    AggregateRootWithSnapshotting,
    AggregateStreamWithSnapshotting,
    Snapshot,
} from '@deltic/event-sourcing/snapshotting';

// ============ Test Stream Definition ============

export interface TestStream extends AggregateStream<TestStream> {
    aggregateRootId: string;
    messages: {
        item_added: {itemId: string; name: string};
        item_removed: {itemId: string};
    };
    aggregateRoot: TestAggregateRoot;
}

// ============ Test Aggregate Root ============

export class TestAggregateRoot extends AggregateRootBehavior<TestStream> {
    private items: Map<string, string> = new Map();

    addItem(itemId: string, name: string): void {
        if (!this.items.has(itemId)) {
            this.recordThat('item_added', {itemId, name});
        }
    }

    removeItem(itemId: string): void {
        if (this.items.has(itemId)) {
            this.recordThat('item_removed', {itemId});
        }
    }

    getItem(itemId: string): string | undefined {
        return this.items.get(itemId);
    }

    hasItem(itemId: string): boolean {
        return this.items.has(itemId);
    }

    get itemCount(): number {
        return this.items.size;
    }

    protected apply(message: AnyMessageFrom<TestStream>): void {
        switch (message.type) {
            case 'item_added':
                this.items.set(message.payload.itemId, message.payload.name);
                break;
            case 'item_removed':
                this.items.delete(message.payload.itemId);
                break;
        }
        this.aggregateRootVersionNumber = message.headers.aggregate_root_version ?? this.aggregateRootVersionNumber;
    }
}

// ============ Test Aggregate Root Factory ============

export class TestAggregateRootFactory implements AggregateRootFactory<TestStream> {
    async reconstituteFromEvents(
        id: string,
        events: AsyncGenerator<AnyMessageFrom<TestStream>>,
    ): Promise<TestAggregateRoot> {
        const aggregate = new TestAggregateRoot(id);

        for await (const event of events) {
            aggregate['apply'](event);
        }

        return aggregate;
    }
}

// ============ Test Stream Definition with Snapshotting ============

export interface TestSnapshotStream extends AggregateStreamWithSnapshotting<TestSnapshotStream> {
    aggregateRootId: string;
    messages: {
        item_added: {itemId: string; name: string};
        item_removed: {itemId: string};
    };
    aggregateRoot: TestSnapshottedAggregateRoot;
    snapshot: {items: Record<string, string>};
}

// ============ Test Aggregate Root with Snapshotting ============

export class TestSnapshottedAggregateRoot
    extends AggregateRootBehavior<TestSnapshotStream>
    implements AggregateRootWithSnapshotting<TestSnapshotStream>
{
    private items: Map<string, string> = new Map();

    addItem(itemId: string, name: string): void {
        if (!this.items.has(itemId)) {
            this.recordThat('item_added', {itemId, name});
        }
    }

    removeItem(itemId: string): void {
        if (this.items.has(itemId)) {
            this.recordThat('item_removed', {itemId});
        }
    }

    getItem(itemId: string): string | undefined {
        return this.items.get(itemId);
    }

    hasItem(itemId: string): boolean {
        return this.items.has(itemId);
    }

    get itemCount(): number {
        return this.items.size;
    }

    createSnapshot(): TestSnapshotStream['snapshot'] {
        return {items: Object.fromEntries(this.items)};
    }

    restoreFromSnapshot(snapshot: TestSnapshotStream['snapshot'], version: number): void {
        this.items = new Map(Object.entries(snapshot.items));
        this.aggregateRootVersionNumber = version;
    }

    protected apply(message: AnyMessageFrom<TestSnapshotStream>): void {
        switch (message.type) {
            case 'item_added':
                this.items.set(message.payload.itemId, message.payload.name);
                break;
            case 'item_removed':
                this.items.delete(message.payload.itemId);
                break;
        }
        this.aggregateRootVersionNumber = message.headers.aggregate_root_version ?? this.aggregateRootVersionNumber;
    }
}

// ============ Test Aggregate Root Factory with Snapshotting ============

export class TestSnapshottedAggregateRootFactory implements AggregateRootFactoryWithSnapshotting<TestSnapshotStream> {
    async reconstituteFromEvents(
        id: string,
        events: AsyncGenerator<AnyMessageFrom<TestSnapshotStream>>,
    ): Promise<TestSnapshottedAggregateRoot> {
        const aggregate = new TestSnapshottedAggregateRoot(id);

        for await (const event of events) {
            aggregate['apply'](event);
        }

        return aggregate;
    }

    async reconstituteFromSnapshot(
        id: string,
        snapshot: Snapshot<TestSnapshotStream>,
        events?: AsyncGenerator<AnyMessageFrom<TestSnapshotStream>>,
    ): Promise<TestSnapshottedAggregateRoot> {
        const aggregate = new TestSnapshottedAggregateRoot(id);
        aggregate.restoreFromSnapshot(snapshot.state, snapshot.version);

        if (events) {
            for await (const event of events) {
                aggregate['apply'](event);
            }
        }

        return aggregate;
    }
}
