import {
    type AggregateRoot,
    type AggregateRootFactory,
    type AggregateStream,
    EventSourcedAggregateRepository,
} from './index.js';
import type {AnyMessageFrom, MessageDecorator, MessageDispatcher, MessageRepository} from '@deltic/messaging';
import {NoopTransactionManager, type TransactionManager} from '@deltic/transaction-manager';

export interface Snapshot<Stream extends AggregateStreamWithSnapshotting<Stream>> {
    readonly aggregateRootId: Stream['aggregateRootId'];
    readonly version: number;
    readonly state: Stream['snapshot'];
}

export type SnapshotType =
    | string
    | number
    | null
    | undefined
    | object
    | boolean
    | {
          [index: string | number]: SnapshotType;
      }
    | Array<SnapshotType>;

export interface AggregateStreamWithSnapshotting<
    Stream extends AggregateStreamWithSnapshotting<Stream> & AggregateStream<Stream>,
> extends AggregateStream<Stream> {
    snapshot: SnapshotType;
    aggregateRoot: AggregateRootWithSnapshotting<Stream>;
}

export interface AggregateRootWithSnapshotting<
    Stream extends AggregateStreamWithSnapshotting<Stream> & AggregateStream<Stream>,
> extends AggregateRoot<Stream> {
    createSnapshot(): Stream['snapshot'];
}

export interface AggregateRootFactoryWithSnapshotting<
    Stream extends AggregateStreamWithSnapshotting<Stream>,
> extends AggregateRootFactory<Stream> {
    reconstituteFromSnapshot(
        id: Stream['aggregateRootId'],
        snapshot: Snapshot<Stream>,
        events?: AsyncGenerator<AnyMessageFrom<Stream>>,
    ): Promise<Stream['aggregateRoot']>;
}

/**
 * @deprecated BC export, use AggregateRootFactoryWithSnapshotting instead
 */
export interface AggregateRootWithFactorySnapshotting<
    Stream extends AggregateStreamWithSnapshotting<Stream>,
> extends AggregateRootFactoryWithSnapshotting<Stream> {}

export class AggregateRootRepositoryWithSnapshotting<
    Stream extends AggregateStreamWithSnapshotting<Stream>,
> extends EventSourcedAggregateRepository<Stream> {
    constructor(
        protected readonly factory: AggregateRootFactoryWithSnapshotting<Stream>,
        protected readonly snapshots: SnapshotRepository<Stream>,
        protected readonly messageRepository: MessageRepository<Stream>,
        protected readonly messageDispatcher: MessageDispatcher<Stream> | undefined = undefined,
        protected readonly messageDecorator: MessageDecorator<Stream> = {
            decorate: messages => messages,
        },
        private readonly authoritativeSnapshots: boolean = false,
        protected readonly transactions: TransactionManager = new NoopTransactionManager(),
    ) {
        super(
            factory,
            messageRepository,
            messageDispatcher,
            messageDecorator,
            // ensure we manage the transactions here and not one level deeper
            new NoopTransactionManager(),
        );
    }

    async persist(aggregateRoot: Stream['aggregateRoot'], storeSnapshot: boolean = true): Promise<void> {
        if (!storeSnapshot) {
            return super.persist(aggregateRoot as any);
        }

        const alreadyInTransaction = this.transactions.inTransaction();

        if (!alreadyInTransaction) {
            await this.transactions.begin();
        }

        try {
            const snapshot: Snapshot<Stream> = {
                aggregateRootId: aggregateRoot.aggregateRootId,
                version: aggregateRoot.aggregateRootVersion(),
                state: aggregateRoot.createSnapshot(),
            };

            await this.snapshots.store(snapshot);
            await super.persist(aggregateRoot as any);

            if (!alreadyInTransaction) {
                await this.transactions.commit();
            }
        } catch (error) {
            if (!alreadyInTransaction) {
                await this.transactions.rollback();
            }
            throw error;
        }
    }

    async retrieve(id: Stream['aggregateRootId']): Promise<Stream['aggregateRoot']> {
        const snapshot = await this.snapshots.retrieve(id);

        if (snapshot === undefined) {
            return super.retrieve(id);
        }

        return this.factory.reconstituteFromSnapshot(
            id,
            snapshot,
            this.authoritativeSnapshots
                ? undefined
                : this.messageRepository.retrieveAllAfterVersion(id, snapshot.version),
        );
    }
}

export interface SnapshotRepository<Stream extends AggregateStreamWithSnapshotting<Stream>> {
    store(snapshot: Snapshot<Stream>): Promise<void>;

    retrieve(id: Stream['aggregateRootId']): Promise<Snapshot<Stream> | undefined>;

    clear(): Promise<void>;
}

export class SnapshotRepositoryForTesting<
    Stream extends AggregateStreamWithSnapshotting<Stream>,
> implements SnapshotRepository<Stream> {
    private readonly snapshots: Map<Stream['aggregateRootId'], Snapshot<Stream>> = new Map();

    async clear(): Promise<void> {
        this.snapshots.clear();
    }

    async store(snapshot: Snapshot<Stream>): Promise<void> {
        if (process.env.NODE_ENV === 'test') {
            expect(snapshot).toEqual(JSON.parse(JSON.stringify(snapshot)));
        }

        this.snapshots.set(snapshot.aggregateRootId, snapshot);
    }

    async retrieve(id: Stream['aggregateRootId']): Promise<Snapshot<Stream> | undefined> {
        return this.snapshots.get(id);
    }
}
