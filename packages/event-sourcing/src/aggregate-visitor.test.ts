import type {AnyMessageFrom, MessageRepository} from '@deltic/messaging';
import type {OrderStream} from '@deltic/event-sourcing/order.stubs';
import {MessageRepositoryUsingMemory} from '@deltic/messaging/message-repository-using-memory';
import type {OffsetRepository} from '@deltic/offset-tracking';
import {messageFactory, messageWithHeader} from '@deltic/messaging/helpers';
import {AggregateVisitor, type AggregateVisitorOptions} from '@deltic/event-sourcing/aggregate-visitor';
import {OffsetRepositoryUsingMemory} from '@deltic/offset-tracking/memory';
import {MutexUsingMemory} from '@deltic/mutex/memory';
import {CollectingMessageConsumer} from '@deltic/messaging/collecting-message-consumer';
import {WaitingMessageConsumer} from '@deltic/messaging/waiting-message-consumer';

const createMessage = messageFactory<OrderStream>();
const orderId1 = 'order-01';
const orderId2 = 'order-02';
const orderId3 = 'order-03';

const dummyMessages: AnyMessageFrom<OrderStream>[] = [
    createMessage('order_was_placed', {
        customer: 'customer',
        total: 0,
    }, {
        aggregate_root_version: 1,
    }),
    createMessage('item_was_added', {
        quantity: 10,
        sku: '123456',
    }, {
        aggregate_root_version: 2,
    }),
    createMessage('order_was_shipped', {
        carrier: 'company-name',
        tracking_number: '1234567890',
    }, {
        aggregate_root_version: 3,
    }),
    createMessage('delivery_was_scheduled', {
        scheduled_for: 1234567890,
    }, {
        aggregate_root_version: 4,
    }),
];

function messagesFor(orderId: string, amount: 1 | 2 | 3 | 4): AnyMessageFrom<OrderStream>[] {
    return dummyMessages.slice(0, amount)
        .map(m => messageWithHeader(structuredClone(m), {
            value: orderId,
            key: 'aggregate_root_id',
        }));
}

function expectedMessage(orderId: string, version: 1 | 2 | 3 | 4): AnyMessageFrom<OrderStream> {
    const message = dummyMessages.slice(version - 1, version)
        .map(m => messageWithHeader(structuredClone(m), {
            value: orderId,
            key: 'aggregate_root_id',
        }))
        .at(0)!;

    return {
        ...message,
        headers: expect.objectContaining(message.headers),
    };
}

describe('AggregateVisitor', () => {
    let messages: MessageRepository<OrderStream>;
    let offsets: OffsetRepository<string>;
    let collector: CollectingMessageConsumer<OrderStream>;
    let waitingConsumer: WaitingMessageConsumer<OrderStream>;
    let visitor: AggregateVisitor<OrderStream> | undefined = undefined;

    function createVisitor(options: Partial<AggregateVisitorOptions<OrderStream>> = {}): AggregateVisitor<OrderStream> {
        return new AggregateVisitor<OrderStream>(
            new MutexUsingMemory(),
            messages,
            offsets,
            waitingConsumer,
            {
                identifier: 'identifier',
                batchSize: 1,
                ...options,
            },
        );
    }

    async function runVisitorUntil(numberOfMessages: number): Promise<void> {
        waitingConsumer.expectDeliveryAmount(numberOfMessages);

        await Promise.allSettled([
            visitor?.run(),
            (async () => {
                await waitingConsumer.wait();

                await visitor?.stop();
            })(),
        ]);
    }

    beforeEach(() => {
        messages = new MessageRepositoryUsingMemory<OrderStream>();
        offsets = new OffsetRepositoryUsingMemory<string>();
        collector = new CollectingMessageConsumer<OrderStream>();
        waitingConsumer = new WaitingMessageConsumer(collector);
    });

    describe('paginating over all known entity IDs', () => {
        it('paginates over the first known message', async () => {
            await messages.persist(orderId1, messagesFor(orderId1, 4));
            await messages.persist(orderId2, messagesFor(orderId2, 1));
            await messages.persist(orderId3, messagesFor(orderId2, 3));

            visitor = createVisitor({
                whichMessage: 'first',
            });

            await runVisitorUntil(3);

            expect(collector.messages).toEqual([
                expectedMessage(orderId1, 1),
                expectedMessage(orderId2, 1),
                expectedMessage(orderId3, 1),
            ]);
        });

        it('paginates over the last known message', async () => {
            await messages.persist(orderId1, messagesFor(orderId1, 1));
            await messages.persist(orderId2, messagesFor(orderId2, 3));
            await messages.persist(orderId3, messagesFor(orderId2, 4));

            visitor = createVisitor({
                whichMessage: 'last',
            });

            await runVisitorUntil(3);

            expect(collector.messages).toEqual([
                expectedMessage(orderId1, 1),
                expectedMessage(orderId2, 3),
                expectedMessage(orderId3, 4),
            ]);
        });
    });

    describe('when paginated before', () => {
        it('paginates over less messages', async () => {
            await messages.persist(orderId1, messagesFor(orderId1, 2));
            await messages.persist(orderId2, messagesFor(orderId2, 2));
            await messages.persist(orderId3, messagesFor(orderId2, 2));

            await offsets.store('identifier', orderId1);

            visitor = createVisitor({
                whichMessage: 'first',
            });

            await runVisitorUntil(2);

            expect(collector.messages).toEqual([
                expectedMessage(orderId2, 1),
                expectedMessage(orderId3, 1),
            ]);
        });
    });
});
