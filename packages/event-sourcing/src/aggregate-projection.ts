import type {TransactionManager} from '@deltic/transaction-manager';
import type {AggregateRepository, AggregateRoot, AggregateStream} from './index.js';

export interface AggregateProjector<Stream extends AggregateStream<Stream>> {
    upsert(aggregate: AggregateRoot<Stream>): Promise<void>;
}

export class AggregateRepositoryWithProjector<
    Stream extends AggregateStream<Stream>,
> implements AggregateRepository<Stream> {
    constructor(
        private readonly repository: AggregateRepository<Stream>,
        private readonly projector: AggregateProjector<Stream>,
        private readonly transactionManager: TransactionManager,
    ) {}

    async persist(aggregateRoot: Stream['aggregateRoot']): Promise<void> {
        const alreadyInTransaction = this.transactionManager.inTransaction();

        if (!alreadyInTransaction) {
            await this.transactionManager.begin();
        }

        try {
            await this.projector.upsert(aggregateRoot);
            await this.repository.persist(aggregateRoot);
        } catch (e) {
            if (!alreadyInTransaction) {
                await this.transactionManager.rollback(e);
            }
            throw e;
        }

        if (!alreadyInTransaction) {
            await this.transactionManager.commit();
        }
    }

    retrieve(id: Stream['aggregateRootId']): Promise<Stream['aggregateRoot']> {
        return this.repository.retrieve(id);
    }

    retrieveAtVersion(id: Stream['aggregateRootId'], version: number): Promise<Stream['aggregateRoot']> {
        return this.repository.retrieveAtVersion(id, version);
    }
}

export class MultiAggregateProjector<Stream extends AggregateStream<Stream>> implements AggregateProjector<Stream> {
    constructor(private projectors: AggregateProjector<Stream>[]) {}

    async upsert(aggregate: AggregateRoot<Stream>): Promise<void> {
        for (const projector of this.projectors) {
            await projector.upsert(aggregate);
        }
    }
}
