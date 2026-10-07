import type {
    AggregateIdWithStreamOffset,
    AnyMessageFrom,
    IdPaginationOptions,
    MessageRepository,
    MessagesFrom,
    StreamDefinition,
} from '@deltic/messaging';
import type {TransactionManager} from '@deltic/transaction-manager';

/**
 * Records the transaction lifecycle so tests can assert that repositories either
 * open their own transaction or join the one started by the caller.
 */
export class RecordingTransactionManager implements TransactionManager {
    readonly calls: string[] = [];
    readonly rollbackCauses: unknown[] = [];
    private active: boolean;

    constructor(startedInTransaction: boolean = false) {
        this.active = startedInTransaction;
    }

    async begin(): Promise<void> {
        this.calls.push('begin');
        this.active = true;
    }

    async commit(): Promise<void> {
        this.calls.push('commit');
        this.active = false;
    }

    async rollback(error?: unknown): Promise<void> {
        this.calls.push('rollback');
        this.rollbackCauses.push(error);
        this.active = false;
    }

    inTransaction(): boolean {
        return this.active;
    }

    async runInIsolation<R>(fn: () => Promise<R>): Promise<R> {
        return fn();
    }

    async runInTransaction<R>(fn: () => Promise<R>): Promise<R> {
        if (this.active) {
            return fn();
        }

        await this.begin();

        try {
            const result = await fn();
            await this.commit();

            return result;
        } catch (error) {
            await this.rollback();
            throw error;
        }
    }

    async runInIsolatedTransaction<R>(fn: () => Promise<R>): Promise<R> {
        return this.runInTransaction(fn);
    }
}

/**
 * Wraps a message repository so a test can make individual writes fail, which is
 * how a transient database outage presents itself to the aggregate repository.
 */
export class MessageRepositoryWithFailures<Stream extends StreamDefinition> implements MessageRepository<Stream> {
    private readonly failures: unknown[] = [];
    private numberOfWrites = 0;

    constructor(private readonly inner: MessageRepository<Stream>) {}

    failNextWrite(error: unknown): void {
        this.failures.push(error);
    }

    get writeCount(): number {
        return this.numberOfWrites;
    }

    async persist(id: Stream['aggregateRootId'], messages: MessagesFrom<Stream>): Promise<void> {
        this.numberOfWrites++;
        const failure = this.failures.shift();

        if (failure !== undefined) {
            throw failure;
        }

        return this.inner.persist(id, messages);
    }

    retrieveAllForAggregate(id: Stream['aggregateRootId']): AsyncGenerator<AnyMessageFrom<Stream>> {
        return this.inner.retrieveAllForAggregate(id);
    }

    retrieveAllAfterVersion(
        id: Stream['aggregateRootId'],
        version: number,
    ): AsyncGenerator<AnyMessageFrom<Stream>> {
        return this.inner.retrieveAllAfterVersion(id, version);
    }

    retrieveAllUntilVersion(
        id: Stream['aggregateRootId'],
        version: number,
    ): AsyncGenerator<AnyMessageFrom<Stream>> {
        return this.inner.retrieveAllUntilVersion(id, version);
    }

    retrieveBetweenVersions(
        id: Stream['aggregateRootId'],
        after: number,
        before: number,
    ): AsyncGenerator<AnyMessageFrom<Stream>> {
        return this.inner.retrieveBetweenVersions(id, after, before);
    }

    paginateIds(options: IdPaginationOptions<Stream>): AsyncGenerator<AggregateIdWithStreamOffset<Stream>> {
        return this.inner.paginateIds(options);
    }
}

/**
 * A message repository that refuses every read, used to prove that authoritative
 * snapshots never touch the event stream.
 */
export class MessageRepositoryThatRefusesReads<Stream extends StreamDefinition>
    implements MessageRepository<Stream>
{
    constructor(private readonly inner: MessageRepository<Stream>) {}

    persist(id: Stream['aggregateRootId'], messages: MessagesFrom<Stream>): Promise<void> {
        return this.inner.persist(id, messages);
    }

    retrieveAllForAggregate(): AsyncGenerator<AnyMessageFrom<Stream>> {
        throw new Error('The event stream should not have been read.');
    }

    retrieveAllAfterVersion(): AsyncGenerator<AnyMessageFrom<Stream>> {
        throw new Error('The event stream should not have been read.');
    }

    retrieveAllUntilVersion(): AsyncGenerator<AnyMessageFrom<Stream>> {
        throw new Error('The event stream should not have been read.');
    }

    retrieveBetweenVersions(): AsyncGenerator<AnyMessageFrom<Stream>> {
        throw new Error('The event stream should not have been read.');
    }

    paginateIds(): AsyncGenerator<AggregateIdWithStreamOffset<Stream>> {
        throw new Error('The event stream should not have been read.');
    }
}
