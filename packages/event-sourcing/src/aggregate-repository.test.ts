import {createTestClock} from '@deltic/clock';
import type {MessageRepository} from '@deltic/messaging';
import {collect, createMessageDecorator, createMessageDispatcher} from '@deltic/messaging/helpers';
import {CollectingMessageDispatcher} from '@deltic/messaging/collecting-message-dispatcher';
import {MessageRepositoryUsingMemory} from '@deltic/messaging/message-repository-using-memory';
import {EventSourcedAggregateRepository} from './index.js';
import {ExampleUsingHandlerMap} from './example-stream.stubs.js';
import {Order, emptyOrderState, type OrderStream} from './order.stubs.js';
import {MessageRepositoryWithFailures, RecordingTransactionManager} from './repository.stubs.js';

const orderId = 'order-1';

describe('EventSourcedAggregateRepository', () => {
    let events: MessageRepositoryUsingMemory<OrderStream>;
    let messages: MessageRepositoryWithFailures<OrderStream>;
    let dispatcher: CollectingMessageDispatcher<OrderStream>;
    let transactions: RecordingTransactionManager;

    const createRepository = (options: {transactions?: RecordingTransactionManager} = {}) =>
        new EventSourcedAggregateRepository<OrderStream>(
            Order,
            messages,
            dispatcher,
            undefined,
            options.transactions ?? transactions,
        );

    beforeEach(() => {
        events = new MessageRepositoryUsingMemory<OrderStream>();
        messages = new MessageRepositoryWithFailures<OrderStream>(events);
        dispatcher = new CollectingMessageDispatcher<OrderStream>();
        transactions = new RecordingTransactionManager();
    });

    describe('persisting an aggregate', () => {
        test('writes the recorded events and dispatches them inside a transaction', async () => {
            const repository = createRepository();
            const order = Order.place(orderId, 'frank', 100);
            order.addItem('sku-1', 2);

            await repository.persist(order);

            expect(transactions.calls).toEqual(['begin', 'commit']);
            expect(dispatcher.producedMessages().map(message => message.type)).toEqual([
                'order_was_placed',
                'item_was_added',
            ]);
            const stored = await collect(events.retrieveAllForAggregate(orderId));
            expect(stored.map(message => message.type)).toEqual(['order_was_placed', 'item_was_added']);
        });

        test('does nothing at all when the aggregate has no new events', async () => {
            const repository = createRepository();
            const order = await repository.retrieve(orderId);

            await repository.persist(order);

            expect(transactions.calls).toEqual([]);
            expect(messages.writeCount).toEqual(0);
            expect(dispatcher.dispatchCount).toEqual(0);
        });

        test('joins a transaction that the caller already started', async () => {
            const callerTransaction = new RecordingTransactionManager(true);
            const repository = createRepository({transactions: callerTransaction});
            const order = Order.place(orderId, 'frank', 100);

            await repository.persist(order);

            expect(callerTransaction.calls).toEqual([]);
            expect(messages.writeCount).toEqual(1);
        });

        test('rolls back the transaction when writing the events fails', async () => {
            const repository = createRepository();
            const order = Order.place(orderId, 'frank', 100);
            messages.failNextWrite(new Error('connection reset by peer'));

            await expect(repository.persist(order)).rejects.toThrow('connection reset by peer');

            expect(transactions.calls).toEqual(['begin', 'rollback']);
            expect(dispatcher.dispatchCount).toEqual(0);
        });

        test('rolls back the transaction when dispatching the events fails', async () => {
            const failingDispatcher = createMessageDispatcher<OrderStream>(async () => {
                throw new Error('the outbox is unavailable');
            });
            const repository = new EventSourcedAggregateRepository<OrderStream>(
                Order,
                messages,
                failingDispatcher,
                undefined,
                transactions,
            );
            const order = Order.place(orderId, 'frank', 100);

            await expect(repository.persist(order)).rejects.toThrow('the outbox is unavailable');

            expect(transactions.calls).toEqual(['begin', 'rollback']);
        });

        test('does not roll back a transaction owned by the caller', async () => {
            const callerTransaction = new RecordingTransactionManager(true);
            const repository = createRepository({transactions: callerTransaction});
            const order = Order.place(orderId, 'frank', 100);
            messages.failNextWrite(new Error('connection reset by peer'));

            await expect(repository.persist(order)).rejects.toThrow('connection reset by peer');

            expect(callerTransaction.calls).toEqual([]);
        });

        test('stores and dispatches the decorated events', async () => {
            const repository = new EventSourcedAggregateRepository<OrderStream>(
                Order,
                messages,
                dispatcher,
                createMessageDecorator<OrderStream>(message => ({
                    ...message,
                    headers: {...message.headers, correlation_id: 'correlation-1'},
                })),
                transactions,
            );
            const order = Order.place(orderId, 'frank', 100);

            await repository.persist(order);

            expect(dispatcher.producedMessages()[0].headers['correlation_id']).toEqual('correlation-1');
            const stored = await collect(events.retrieveAllForAggregate(orderId));
            expect(stored[0].headers['correlation_id']).toEqual('correlation-1');
        });

        test('dispatches the events only after they were written', async () => {
            const observed: string[] = [];
            const observingRepository: MessageRepository<OrderStream> = {
                persist: async (id, messagesToPersist) => {
                    observed.push('write');
                    return events.persist(id, messagesToPersist);
                },
                retrieveAllForAggregate: id => events.retrieveAllForAggregate(id),
                retrieveAllAfterVersion: (id, version) => events.retrieveAllAfterVersion(id, version),
                retrieveAllUntilVersion: (id, version) => events.retrieveAllUntilVersion(id, version),
                retrieveBetweenVersions: (id, after, before) => events.retrieveBetweenVersions(id, after, before),
                paginateIds: options => events.paginateIds(options),
            };
            const repository = new EventSourcedAggregateRepository<OrderStream>(
                Order,
                observingRepository,
                createMessageDispatcher<OrderStream>(async () => {
                    observed.push('dispatch');
                }),
                undefined,
                transactions,
            );

            await repository.persist(Order.place('order-a', 'frank', 100));
            await repository.persist(Order.place('order-b', 'renske', 50));

            expect(observed).toEqual(['write', 'dispatch', 'write', 'dispatch']);
        });

        test('works without a message dispatcher', async () => {
            const repository = new EventSourcedAggregateRepository<OrderStream>(
                Order,
                messages,
                undefined,
                undefined,
                transactions,
            );

            await repository.persist(Order.place(orderId, 'frank', 100));

            expect(await collect(events.retrieveAllForAggregate(orderId))).toHaveLength(1);
            expect(transactions.calls).toEqual(['begin', 'commit']);
        });

        test('tells the transaction manager why it is rolling back', async () => {
            const repository = createRepository();
            const order = Order.place(orderId, 'frank', 100);
            const failure = new Error('connection reset by peer');
            messages.failNextWrite(failure);

            await expect(repository.persist(order)).rejects.toThrow(failure);

            expect(transactions.rollbackCauses).toEqual([failure]);
        });

        test('keeps the recorded events on the aggregate when writing them fails', async () => {
            const repository = createRepository();
            const order = Order.place(orderId, 'frank', 100);
            messages.failNextWrite(new Error('connection reset by peer'));

            await expect(repository.persist(order)).rejects.toThrow('connection reset by peer');

            // A caller that retries the write expects the events to still be there.
            expect(order.hasUnreleasedEvents()).toBe(true);

            await repository.persist(order);

            expect(await collect(events.retrieveAllForAggregate(orderId))).toHaveLength(1);
            expect(order.hasUnreleasedEvents()).toBe(false);
        });

        test('keeps the recorded events on the aggregate when committing fails', async () => {
            const failingCommit = new (class extends RecordingTransactionManager {
                async commit(): Promise<void> {
                    await super.commit();
                    throw new Error('could not serialize access');
                }
            })();
            const repository = createRepository({transactions: failingCommit});
            const order = Order.place(orderId, 'frank', 100);

            await expect(repository.persist(order)).rejects.toThrow('could not serialize access');

            expect(order.hasUnreleasedEvents()).toBe(true);
        });
    });

    describe('version integrity', () => {
        test('numbers recorded events strictly monotonically without gaps', async () => {
            const order = Order.place(orderId, 'frank', 100);
            order.addItem('sku-1', 1);
            order.addItem('sku-2', 1);

            expect(order.peekEvents().map(message => message.headers['aggregate_root_version'])).toEqual([1, 2, 3]);
            expect(order.aggregateRootVersion()).toEqual(3);
        });

        test('continues the version sequence after the aggregate was reconstituted', async () => {
            const repository = createRepository();
            const order = Order.place(orderId, 'frank', 100);
            order.addItem('sku-1', 1);
            await repository.persist(order);

            const reloaded = await repository.retrieve(orderId);
            reloaded.addItem('sku-2', 1);
            await repository.persist(reloaded);

            const stored = await collect(events.retrieveAllForAggregate(orderId));
            expect(stored.map(message => message.headers['aggregate_root_version'])).toEqual([1, 2, 3]);
        });

        test('reports the version that a subsequent read observes', async () => {
            const repository = createRepository();
            const order = Order.place(orderId, 'frank', 100);
            order.addItem('sku-1', 1);
            await repository.persist(order);
            const versionAfterWriting = order.aggregateRootVersion();

            const reloaded = await repository.retrieve(orderId);

            expect(reloaded.aggregateRootVersion()).toEqual(versionAfterWriting);
        });
    });

    describe('retrieving an aggregate', () => {
        test('reconstitutes an aggregate that was never persisted as an empty aggregate', async () => {
            const repository = createRepository();

            const order = await repository.retrieve('an-id-that-does-not-exist');

            expect(order.aggregateRootVersion()).toEqual(0);
            expect(order.currentState()).toEqual({customer: undefined, total: 0, items: {}, shipped: false});
            expect(order.hasUnreleasedEvents()).toBe(false);
        });

        test('reconstitutes the aggregate up to and including the requested version', async () => {
            const repository = createRepository();
            const order = Order.place(orderId, 'frank', 100);
            order.addItem('sku-1', 1);
            order.addItem('sku-2', 1);
            await repository.persist(order);

            const atVersionTwo = await repository.retrieveAtVersion(orderId, 2);

            expect(atVersionTwo.aggregateRootVersion()).toEqual(2);
            expect(atVersionTwo.currentState().items).toEqual({'sku-1': 1});
        });

        test('reconstitutes an empty aggregate at version zero', async () => {
            const repository = createRepository();
            const order = Order.place(orderId, 'frank', 100);
            await repository.persist(order);

            const atVersionZero = await repository.retrieveAtVersion(orderId, 0);

            expect(atVersionZero.aggregateRootVersion()).toEqual(0);
            expect(atVersionZero.currentState().customer).toBeUndefined();
        });
    });

    describe('stamping the time of recording', () => {
        test('takes the time of recording from the clock it was given', async () => {
            const clock = createTestClock('2026-08-04T10:00:00.000Z');
            const order = new Order(orderId, emptyOrderState(), {clock});

            order.placeFor('frank', 100);
            clock.advance(5_000);
            order.addItem('sku-1', 1);

            const [placed, added] = order.releaseEvents();
            expect(placed.headers['time_of_recording']).toEqual('2026-08-04T10:00:00.000Z');
            expect(placed.headers['time_of_recording_ms']).toEqual(Date.parse('2026-08-04T10:00:00.000Z'));
            expect(added.headers['time_of_recording']).toEqual('2026-08-04T10:00:05.000Z');
        });

        test('lets the clock override a time of recording handed to it by the aggregate', async () => {
            const clock = createTestClock('2026-08-04T10:00:00.000Z');
            const example = new ExampleUsingHandlerMap('example-1', {clock});
            example.addMember({id: '1', name: 'Frank', age: 32});
            example.releaseEvents();

            // removeMember records with time_of_recording: 'now' and time_of_recording_ms: 0
            example.removeMember('1');

            const [removed] = example.releaseEvents();
            expect(removed.headers['time_of_recording']).toEqual('2026-08-04T10:00:00.000Z');
            expect(removed.headers['time_of_recording_ms']).toEqual(Date.parse('2026-08-04T10:00:00.000Z'));
        });
    });

    describe('handing over recorded events', () => {
        test('releases the recorded events exactly once', async () => {
            const order = Order.place(orderId, 'frank', 100);

            expect(order.releaseEvents()).toHaveLength(1);
            expect(order.releaseEvents()).toHaveLength(0);
            expect(order.hasUnreleasedEvents()).toBe(false);
        });

        test('peeking at the recorded events leaves them on the aggregate', async () => {
            const order = Order.place(orderId, 'frank', 100);

            expect(order.peekEvents()).toHaveLength(1);
            expect(order.hasUnreleasedEvents()).toBe(true);
            expect(order.releaseEvents()).toHaveLength(1);
        });

        test('peeking hands out a copy that cannot corrupt the recorded events', async () => {
            const order = Order.place(orderId, 'frank', 100);

            const peeked = order.peekEvents();
            peeked.length = 0;

            expect(order.peekEvents()).toHaveLength(1);
            expect(order.peekEvents()[0]).not.toBe(order.peekEvents()[0]);

            const released = order.releaseEvents();
            expect(released).toHaveLength(1);
            expect(released[0].payload).toEqual({customer: 'frank', total: 100});
        });
    });
});
