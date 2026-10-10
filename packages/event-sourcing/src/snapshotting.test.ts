import {
    AggregateRootRepositoryWithSnapshotting,
    SnapshotRepositoryForTesting,
    type AggregateRootWithSnapshotting,
    type AggregateStreamWithSnapshotting,
    type Snapshot,
} from './snapshotting.js';
import type {AnyMessageFrom, MessageRepository} from '@deltic/messaging';
import {createTestTooling} from './test-tooling.js';
import {MessageRepositoryUsingMemory} from '@deltic/messaging/message-repository-using-memory';
import {AggregateRootUsingReflectMetadata, makeEventHandler} from './using-reflect-metadata.js';
import {EventSourcedAggregateRepository} from './index.js';
import {NoopTransactionManager} from '@deltic/transaction-manager';
import {
    MessageRepositoryThatRefusesReads,
    MessageRepositoryWithFailures,
    RecordingTransactionManager,
} from './repository.stubs.js';

const When = makeEventHandler<SnapshottingTestEvents>();

type TestSnapshot = {total: number};

interface SnapshottingTestEvents extends AggregateStreamWithSnapshotting<SnapshottingTestEvents> {
    topic: 'testing';
    messages: {
        number_was_incremented: {
            by: number;
        };
    };
    aggregateRootId: string;
    aggregateRoot: SnapshottedEntity;
    snapshot: TestSnapshot;
}

class SnapshottedEntity
    extends AggregateRootUsingReflectMetadata<SnapshottingTestEvents>
    implements AggregateRootWithSnapshotting<SnapshottingTestEvents>
{
    private counter: number = 0;

    createSnapshot(): TestSnapshot {
        return {total: this.counter};
    }

    public increment(by: number): void {
        this.recordThat('number_was_incremented', {by});
    }

    @When('number_was_incremented')
    whenNumberWasIncremented(event: {by: number}): void {
        this.counter += event.by;
    }

    static async reconstituteFromEvents(id: string, messages: AsyncGenerator<AnyMessageFrom<SnapshottingTestEvents>>) {
        const aggregateRoot = new SnapshottedEntity(id);

        for await (const m of messages) {
            aggregateRoot.apply(m);
        }

        return aggregateRoot;
    }

    static async reconstituteFromSnapshot(
        id: string,
        snapshot: Snapshot<SnapshottingTestEvents>,
        messages?: AsyncGenerator<AnyMessageFrom<SnapshottingTestEvents>>,
    ) {
        const aggregateRoot = new SnapshottedEntity(id);
        aggregateRoot.aggregateRootVersionNumber = snapshot.version;
        aggregateRoot.counter = snapshot.state.total;

        for await (const m of messages ?? []) {
            aggregateRoot.apply(m);
        }

        return aggregateRoot;
    }
}

const aggregateRootId = 'not important';
const {createMessage} = createTestTooling<SnapshottingTestEvents>(aggregateRootId, SnapshottedEntity);

describe('snapshotting an event-sourced entity', () => {
    const snapshots = new SnapshotRepositoryForTesting<SnapshottingTestEvents>();
    const messages = new MessageRepositoryUsingMemory<SnapshottingTestEvents>();
    const repository = new AggregateRootRepositoryWithSnapshotting(SnapshottedEntity, snapshots, messages);

    afterEach(async () => {
        await snapshots.clear();
        messages.clear();
    });

    test('using a snapshot', async () => {
        // expect this message not to affect the total
        const message1 = createMessage(
            'number_was_incremented',
            {
                by: 5,
            },
            {
                aggregate_root_version: 2,
            },
        );

        // expect these to be played over the snapshot
        const message2 = createMessage(
            'number_was_incremented',
            {
                by: 5,
            },
            {
                aggregate_root_version: 3,
            },
        );
        const message3 = createMessage(
            'number_was_incremented',
            {
                by: 5,
            },
            {
                aggregate_root_version: 4,
            },
        );
        await messages.persist(aggregateRootId, [message1, message2, message3]);

        // persist a snapshot
        await snapshots.store({
            aggregateRootId,
            state: {total: 7},
            version: 2,
        });

        const entity = await repository.retrieve(aggregateRootId);
        const currentSnapshot = entity.createSnapshot();

        expect(currentSnapshot.total).toEqual(17);
    });

    test('storing a new snapshot', async () => {
        const entity = await repository.retrieve(aggregateRootId);
        entity.increment(7);
        entity.increment(8);

        await repository.persist(entity);

        const snapshot = await snapshots.retrieve(aggregateRootId);

        expect(snapshot?.version).toEqual(2);
        expect(snapshot?.state).toEqual({total: 15});
        expect(snapshot?.aggregateRootId).toEqual(aggregateRootId);
    });

    test('not storing a new snapshot', async () => {
        const entity = await repository.retrieve(aggregateRootId);
        entity.increment(7);
        entity.increment(8);

        await repository.persist(entity, false);

        const snapshot = await snapshots.retrieve(aggregateRootId);

        expect(snapshot).toEqual(undefined);
    });

    test('can return to correct version when there are no new events', async () => {
        await snapshots.store({
            aggregateRootId,
            state: {total: 44},
            version: 4,
        });

        const entity = await repository.retrieve(aggregateRootId);

        expect(entity.aggregateRootVersion()).toEqual(4);
    });

    test('new events continue version sequence after being restored from snapshot', async () => {
        await snapshots.store({
            aggregateRootId,
            state: {total: 44},
            version: 4,
        });

        const entity = await repository.retrieve(aggregateRootId);
        entity.increment(11);
        expect(entity.releaseEvents()[0].headers['aggregate_root_version']).toEqual(5);
    });
});

describe('reconstituting from a snapshot instead of the whole stream', () => {
    let snapshots: SnapshotRepositoryForTesting<SnapshottingTestEvents>;
    let messages: MessageRepositoryUsingMemory<SnapshottingTestEvents>;
    let withSnapshotting: AggregateRootRepositoryWithSnapshotting<SnapshottingTestEvents>;
    let withoutSnapshotting: EventSourcedAggregateRepository<SnapshottingTestEvents>;

    const incrementedBy = (by: number, version: number) =>
        createMessage('number_was_incremented', {by}, {aggregate_root_version: version});

    const givenAStreamOf = async (...increments: number[]) => {
        await messages.persist(
            aggregateRootId,
            increments.map((by, index) => incrementedBy(by, index + 1)),
        );
    };

    beforeEach(() => {
        snapshots = new SnapshotRepositoryForTesting<SnapshottingTestEvents>();
        messages = new MessageRepositoryUsingMemory<SnapshottingTestEvents>();
        withSnapshotting = new AggregateRootRepositoryWithSnapshotting(SnapshottedEntity, snapshots, messages);
        withoutSnapshotting = new EventSourcedAggregateRepository<SnapshottingTestEvents>(
            SnapshottedEntity,
            messages,
            undefined,
            undefined,
            new NoopTransactionManager(),
        );
    });

    afterEach(async () => {
        await snapshots.clear();
        messages.clear();
    });

    test('a snapshot plus the events after it reproduces a full replay', async () => {
        await givenAStreamOf(1, 2, 3, 4, 5, 6);
        const asOfVersionThree = await withoutSnapshotting.retrieveAtVersion(aggregateRootId, 3);
        await snapshots.store({
            aggregateRootId,
            version: asOfVersionThree.aggregateRootVersion(),
            state: asOfVersionThree.createSnapshot(),
        });

        const fromSnapshot = await withSnapshotting.retrieve(aggregateRootId);
        const fromFullReplay = await withoutSnapshotting.retrieve(aggregateRootId);

        expect(fromSnapshot.createSnapshot()).toEqual(fromFullReplay.createSnapshot());
        expect(fromSnapshot.aggregateRootVersion()).toEqual(fromFullReplay.aggregateRootVersion());
    });

    test('a snapshot that is far behind the stream still reproduces the current state', async () => {
        await givenAStreamOf(1, 2, 3, 4, 5, 6);
        await snapshots.store({aggregateRootId, version: 1, state: {total: 1}});

        const fromSnapshot = await withSnapshotting.retrieve(aggregateRootId);

        expect(fromSnapshot.createSnapshot()).toEqual({total: 21});
        expect(fromSnapshot.aggregateRootVersion()).toEqual(6);
    });

    test('a snapshot that is up to date needs no events at all', async () => {
        await givenAStreamOf(1, 2, 3);
        await snapshots.store({aggregateRootId, version: 3, state: {total: 6}});

        const fromSnapshot = await withSnapshotting.retrieve(aggregateRootId);

        expect(fromSnapshot.createSnapshot()).toEqual({total: 6});
        expect(fromSnapshot.aggregateRootVersion()).toEqual(3);
    });

    test('replaces the stored snapshot when the aggregate is persisted again', async () => {
        await givenAStreamOf(1, 2);
        await snapshots.store({aggregateRootId, version: 1, state: {total: 1}});
        const entity = await withSnapshotting.retrieve(aggregateRootId);
        entity.increment(10);

        await withSnapshotting.persist(entity);

        expect(await snapshots.retrieve(aggregateRootId)).toEqual({
            aggregateRootId,
            version: 3,
            state: {total: 13},
        });
    });

    test('stores a snapshot even when the aggregate recorded no new events', async () => {
        await givenAStreamOf(1, 2);
        const entity = await withSnapshotting.retrieve(aggregateRootId);

        await withSnapshotting.persist(entity);

        expect(await snapshots.retrieve(aggregateRootId)).toEqual({
            aggregateRootId,
            version: 2,
            state: {total: 3},
        });
    });

    /**
     * A snapshot can only be ahead of the stream when a snapshot was committed while
     * its events were not. The snapshot is trusted without question, so from that
     * moment on the aggregate reports a state that its own event stream cannot explain.
     */
    test('trusts a snapshot that is ahead of the stream', async () => {
        await givenAStreamOf(1, 2);
        await snapshots.store({aggregateRootId, version: 9, state: {total: 100}});

        const fromSnapshot = await withSnapshotting.retrieve(aggregateRootId);
        const fromFullReplay = await withoutSnapshotting.retrieve(aggregateRootId);

        expect(fromSnapshot.createSnapshot()).toEqual({total: 100});
        expect(fromSnapshot.aggregateRootVersion()).toEqual(9);
        expect(fromFullReplay.createSnapshot()).toEqual({total: 3});
        fromSnapshot.increment(1);
        expect(fromSnapshot.releaseEvents()[0].headers['aggregate_root_version']).toEqual(10);
    });

    test('falls back to a full replay when the stored snapshot was discarded', async () => {
        await givenAStreamOf(1, 2, 3);
        await snapshots.store({aggregateRootId, version: 2, state: {total: 3}});
        await snapshots.clear();

        const entity = await withSnapshotting.retrieve(aggregateRootId);

        expect(entity.createSnapshot()).toEqual({total: 6});
        expect(entity.aggregateRootVersion()).toEqual(3);
    });

    test('reconstitutes an aggregate that has neither a snapshot nor events', async () => {
        const entity = await withSnapshotting.retrieve('an-id-that-does-not-exist');

        expect(entity.createSnapshot()).toEqual({total: 0});
        expect(entity.aggregateRootVersion()).toEqual(0);
    });
});

describe('authoritative snapshots', () => {
    let snapshots: SnapshotRepositoryForTesting<SnapshottingTestEvents>;
    let messages: MessageRepositoryUsingMemory<SnapshottingTestEvents>;

    const createRepository = (events: MessageRepository<SnapshottingTestEvents> = messages) =>
        new AggregateRootRepositoryWithSnapshotting<SnapshottingTestEvents>(
            SnapshottedEntity,
            snapshots,
            events,
            undefined,
            undefined,
            true,
        );

    beforeEach(() => {
        snapshots = new SnapshotRepositoryForTesting<SnapshottingTestEvents>();
        messages = new MessageRepositoryUsingMemory<SnapshottingTestEvents>();
    });

    afterEach(async () => {
        await snapshots.clear();
        messages.clear();
    });

    test('does not read the event stream at all', async () => {
        await snapshots.store({aggregateRootId, version: 4, state: {total: 44}});
        const repository = createRepository(new MessageRepositoryThatRefusesReads(messages));

        const entity = await repository.retrieve(aggregateRootId);

        expect(entity.createSnapshot()).toEqual({total: 44});
        expect(entity.aggregateRootVersion()).toEqual(4);
    });

    test('ignores events that were recorded after the snapshot', async () => {
        await messages.persist(aggregateRootId, [
            createMessage('number_was_incremented', {by: 5}, {aggregate_root_version: 1}),
            createMessage('number_was_incremented', {by: 5}, {aggregate_root_version: 2}),
        ]);
        await snapshots.store({aggregateRootId, version: 1, state: {total: 5}});

        const entity = await createRepository().retrieve(aggregateRootId);

        expect(entity.createSnapshot()).toEqual({total: 5});
        expect(entity.aggregateRootVersion()).toEqual(1);
    });

    test('still replays the whole stream when there is no snapshot', async () => {
        await messages.persist(aggregateRootId, [
            createMessage('number_was_incremented', {by: 5}, {aggregate_root_version: 1}),
        ]);

        const entity = await createRepository().retrieve(aggregateRootId);

        expect(entity.createSnapshot()).toEqual({total: 5});
        expect(entity.aggregateRootVersion()).toEqual(1);
    });
});

describe('persisting an aggregate with snapshotting', () => {
    let snapshots: SnapshotRepositoryForTesting<SnapshottingTestEvents>;
    let events: MessageRepositoryUsingMemory<SnapshottingTestEvents>;
    let messages: MessageRepositoryWithFailures<SnapshottingTestEvents>;
    let transactions: RecordingTransactionManager;

    const createRepository = (ownTransactions: RecordingTransactionManager = transactions) =>
        new AggregateRootRepositoryWithSnapshotting<SnapshottingTestEvents>(
            SnapshottedEntity,
            snapshots,
            messages,
            undefined,
            undefined,
            false,
            ownTransactions,
        );

    beforeEach(() => {
        snapshots = new SnapshotRepositoryForTesting<SnapshottingTestEvents>();
        events = new MessageRepositoryUsingMemory<SnapshottingTestEvents>();
        messages = new MessageRepositoryWithFailures<SnapshottingTestEvents>(events);
        transactions = new RecordingTransactionManager();
    });

    afterEach(async () => {
        await snapshots.clear();
        events.clear();
    });

    /**
     * The snapshot and the events are written inside a single transaction that this
     * repository owns. The repository it extends is deliberately handed a no-op
     * transaction manager so it cannot open a nested transaction one level deeper.
     */
    test('opens a single transaction for both the snapshot and the events', async () => {
        const repository = createRepository();
        const entity = await repository.retrieve(aggregateRootId);
        entity.increment(7);

        await repository.persist(entity);

        expect(transactions.calls).toEqual(['begin', 'commit']);
    });

    test('joins a transaction that the caller already started', async () => {
        const callerTransaction = new RecordingTransactionManager(true);
        const repository = createRepository(callerTransaction);
        const entity = await repository.retrieve(aggregateRootId);
        entity.increment(7);

        await repository.persist(entity);

        expect(callerTransaction.calls).toEqual([]);
        expect(await snapshots.retrieve(aggregateRootId)).not.toBeUndefined();
    });

    test('rolls back its own transaction when writing the events fails', async () => {
        const repository = createRepository();
        const entity = await repository.retrieve(aggregateRootId);
        entity.increment(7);
        messages.failNextWrite(new Error('the event store is unavailable'));

        await expect(repository.persist(entity)).rejects.toThrow('the event store is unavailable');

        expect(transactions.calls).toEqual(['begin', 'rollback']);
    });

    test('opens no transaction when no snapshot is stored', async () => {
        const repository = createRepository();
        const entity = await repository.retrieve(aggregateRootId);
        entity.increment(7);

        await repository.persist(entity, false);

        expect(transactions.calls).toEqual([]);
        expect(await snapshots.retrieve(aggregateRootId)).toBeUndefined();
    });

    test('keeps the recorded events on the aggregate when writing them fails', async () => {
        const repository = createRepository();
        const entity = await repository.retrieve(aggregateRootId);
        entity.increment(7);
        messages.failNextWrite(new Error('the event store is unavailable'));

        await expect(repository.persist(entity)).rejects.toThrow('the event store is unavailable');

        expect(entity.hasUnreleasedEvents()).toBe(true);

        await repository.persist(entity);

        expect(entity.hasUnreleasedEvents()).toBe(false);
        expect(messages.writeCount).toEqual(2);
        expect(transactions.calls).toEqual(['begin', 'rollback', 'begin', 'commit']);
    });

});
