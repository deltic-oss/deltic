import {collect} from '@deltic/messaging/helpers';
import {MessageRepositoryUsingMemory} from '@deltic/messaging/message-repository-using-memory';
import {AggregateRepositoryWithProjector, MultiAggregateProjector, type AggregateProjector} from './aggregate-projection.js';
import {EventSourcedAggregateRepository, type AggregateRoot} from './index.js';
import {Order, type OrderStream} from './order.stubs.js';
import {RecordingTransactionManager} from './repository.stubs.js';

const orderId = 'order-1';

class OrderProjector implements AggregateProjector<OrderStream> {
    readonly projected: {id: string; total: number; unreleasedEvents: number}[] = [];

    constructor(private readonly failure: Error | undefined = undefined) {}

    async upsert(aggregate: AggregateRoot<OrderStream>): Promise<void> {
        this.projected.push({
            id: aggregate.aggregateRootId,
            total: (aggregate as Order).currentState().total,
            unreleasedEvents: aggregate.peekEvents().length,
        });

        if (this.failure !== undefined) {
            throw this.failure;
        }
    }
}

describe('AggregateRepositoryWithProjector', () => {
    let events: MessageRepositoryUsingMemory<OrderStream>;
    let transactions: RecordingTransactionManager;
    let innerTransactions: RecordingTransactionManager;
    let inner: EventSourcedAggregateRepository<OrderStream>;

    const createRepository = (projector: AggregateProjector<OrderStream>, ownTransactions = transactions) =>
        new AggregateRepositoryWithProjector<OrderStream>(inner, projector, ownTransactions);

    beforeEach(() => {
        events = new MessageRepositoryUsingMemory<OrderStream>();
        transactions = new RecordingTransactionManager();
        innerTransactions = new RecordingTransactionManager(true);
        inner = new EventSourcedAggregateRepository<OrderStream>(
            Order,
            events,
            undefined,
            undefined,
            innerTransactions,
        );
    });

    test('projects the aggregate and writes its events in a single transaction', async () => {
        const projector = new OrderProjector();
        const repository = createRepository(projector);

        await repository.persist(Order.place(orderId, 'frank', 100));

        expect(transactions.calls).toEqual(['begin', 'commit']);
        expect(projector.projected).toEqual([{id: orderId, total: 100, unreleasedEvents: 1}]);
        expect(await collect(events.retrieveAllForAggregate(orderId))).toHaveLength(1);
    });

    test('hands the projector the events that are about to be written', async () => {
        const projector = new OrderProjector();
        const repository = createRepository(projector);
        const order = Order.place(orderId, 'frank', 100);
        order.addItem('sku-1', 1);

        await repository.persist(order);

        expect(projector.projected[0].unreleasedEvents).toEqual(2);
    });

    test('rolls back and does not write the events when projecting fails', async () => {
        const projector = new OrderProjector(new Error('the read model is unavailable'));
        const repository = createRepository(projector);

        await expect(repository.persist(Order.place(orderId, 'frank', 100))).rejects.toThrow(
            'the read model is unavailable',
        );

        expect(transactions.calls).toEqual(['begin', 'rollback']);
        expect(await collect(events.retrieveAllForAggregate(orderId))).toHaveLength(0);
    });

    test('rolls back when writing the events fails', async () => {
        const projector = new OrderProjector();
        const repository = new AggregateRepositoryWithProjector<OrderStream>(
            {
                persist: async () => {
                    throw new Error('the event store is unavailable');
                },
                retrieve: id => inner.retrieve(id),
                retrieveAtVersion: (id, version) => inner.retrieveAtVersion(id, version),
            },
            projector,
            transactions,
        );

        await expect(repository.persist(Order.place(orderId, 'frank', 100))).rejects.toThrow(
            'the event store is unavailable',
        );

        expect(transactions.calls).toEqual(['begin', 'rollback']);
        expect(projector.projected).toHaveLength(1);
    });

    test('joins a transaction that the caller already started', async () => {
        const callerTransaction = new RecordingTransactionManager(true);
        const projector = new OrderProjector();
        const repository = createRepository(projector, callerTransaction);

        await repository.persist(Order.place(orderId, 'frank', 100));

        expect(callerTransaction.calls).toEqual([]);
        expect(projector.projected).toHaveLength(1);
    });

    test('leaves a caller-owned transaction alone when projecting fails', async () => {
        const callerTransaction = new RecordingTransactionManager(true);
        const projector = new OrderProjector(new Error('the read model is unavailable'));
        const repository = createRepository(projector, callerTransaction);

        await expect(repository.persist(Order.place(orderId, 'frank', 100))).rejects.toThrow(
            'the read model is unavailable',
        );

        expect(callerTransaction.calls).toEqual([]);
    });

    test('delegates retrieval to the wrapped repository', async () => {
        const projector = new OrderProjector();
        const repository = createRepository(projector);
        const order = Order.place(orderId, 'frank', 100);
        order.addItem('sku-1', 1);
        await repository.persist(order);

        const retrieved = await repository.retrieve(orderId);
        const atVersionOne = await repository.retrieveAtVersion(orderId, 1);

        expect(retrieved.aggregateRootVersion()).toEqual(2);
        expect(atVersionOne.aggregateRootVersion()).toEqual(1);
    });
});

describe('MultiAggregateProjector', () => {
    test('projects into every registered projector', async () => {
        const first = new OrderProjector();
        const second = new OrderProjector();
        const projector = new MultiAggregateProjector<OrderStream>([first, second]);

        await projector.upsert(Order.place(orderId, 'frank', 100));

        expect(first.projected).toHaveLength(1);
        expect(second.projected).toHaveLength(1);
    });

    test('stops at the first projector that fails', async () => {
        const failing = new OrderProjector(new Error('the read model is unavailable'));
        const succeeding = new OrderProjector();
        const projector = new MultiAggregateProjector<OrderStream>([failing, succeeding]);

        await expect(projector.upsert(Order.place(orderId, 'frank', 100))).rejects.toThrow(
            'the read model is unavailable',
        );

        expect(succeeding.projected).toHaveLength(0);
    });

    test('reports the first failure when several projectors fail', async () => {
        const first = new OrderProjector(new Error('first read model is unavailable'));
        const second = new OrderProjector(new Error('second read model is unavailable'));
        const projector = new MultiAggregateProjector<OrderStream>([first, second]);

        await expect(projector.upsert(Order.place(orderId, 'frank', 100))).rejects.toThrow(
            'first read model is unavailable',
        );
    });

});
