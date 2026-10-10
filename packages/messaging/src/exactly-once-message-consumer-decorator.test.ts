import {MessageRepositoryUsingMemory} from '@deltic/messaging/message-repository-using-memory';
import type {AnyMessageFrom, MessagesFrom} from '@deltic/messaging';
import {messageFactory} from '@deltic/messaging/helpers';
import {OffsetRepositoryUsingMemory} from '@deltic/offset-tracking/memory';
import {
    ExactlyOnceMessageConsumerDecorator,
    type ExactlyOnceMessageConsumerOptions,
} from '@deltic/messaging/exactly-once-message-consumer-decorator';
import {KeyValueStoreUsingMemory} from '@deltic/key-value/memory';
import {CollectingMessageConsumer} from './collecting-message-consumer.js';
import {ReducingMessageConsumer} from './reducing-message-consumer.js';
import {NoopTransactionManager} from '@deltic/transaction-manager';

const noopTransactions = new NoopTransactionManager();

interface EventsForAutomaticRebuilds {
    topic: 'automatic-rebuilds';
    aggregateRoot: any;
    aggregateRootId: string;
    messages: {
        add: {
            amount: number;
        };
    };
}

describe('AutomaticRebuilds for single aggregate projections', () => {
    const createMessage = messageFactory<EventsForAutomaticRebuilds>();

    /**
     * In this scenario we store five messages. Four messages belong to the aggregate
     * we are going to rebuild. We dispatch the last message and expect the underlying
     * projection to catch up with the event-stream. We test this by incrementing a counter
     * with specific amounts and expect the resulting output to be the sum of all the amounts
     * from all the messages.
     */
    test('it can automatically rebuild projections', async () => {
        const messages = new MessageRepositoryUsingMemory<EventsForAutomaticRebuilds>();
        const projectionStore = new KeyValueStoreUsingMemory<string, number>();
        const rebuildingConsumer = new ExactlyOnceMessageConsumerDecorator<EventsForAutomaticRebuilds>(
            new OffsetRepositoryUsingMemory(),
            new ReducingMessageConsumer<string, number, EventsForAutomaticRebuilds>(
                projectionStore,
                message => `example:${message.headers['aggregate_root_id']}`,
                () => 0,
                (state, payload) => state + payload.payload.amount,
            ),
            messages,
            noopTransactions,
        );
        const storedMessages: MessagesFrom<EventsForAutomaticRebuilds> = [
            ...[25, 15, 10, 50].map((amount, index) =>
                createMessage(
                    'add',
                    {
                        amount,
                    },
                    {
                        aggregate_root_version: index + 1,
                        aggregate_root_id: '1234',
                    },
                ),
            ),
            // ⬇️ not matching the main aggregate ID on purpose
            createMessage(
                'add',
                {
                    amount: 15,
                },
                {
                    aggregate_root_version: 1,
                    aggregate_root_id: '4321',
                },
            ),
        ];

        for (const message of storedMessages) {
            await messages.persist(String(message.headers['aggregate_root_id']), [message]);
        }

        await rebuildingConsumer.consume(storedMessages[3]);

        const total = await projectionStore.retrieve('example:1234');

        expect(total).toEqual(100);
    });
});

describe('ExactlyOnceMessageConsumerDecorator', () => {
    const createMessage = messageFactory<EventsForAutomaticRebuilds>();
    const message = (version: number): AnyMessageFrom<EventsForAutomaticRebuilds> =>
        createMessage('add', {amount: version}, {
            aggregate_root_version: version,
            aggregate_root_id: '1234',
        });

    let offsets: OffsetRepositoryUsingMemory;
    let messages: MessageRepositoryUsingMemory<EventsForAutomaticRebuilds>;
    let inner: CollectingMessageConsumer<EventsForAutomaticRebuilds>;

    const decorate = (options: ExactlyOnceMessageConsumerOptions<EventsForAutomaticRebuilds> = {}) =>
        new ExactlyOnceMessageConsumerDecorator<EventsForAutomaticRebuilds>(
            offsets,
            inner,
            messages,
            noopTransactions,
            options,
        );

    beforeEach(() => {
        offsets = new OffsetRepositoryUsingMemory();
        messages = new MessageRepositoryUsingMemory<EventsForAutomaticRebuilds>();
        inner = new CollectingMessageConsumer<EventsForAutomaticRebuilds>();
    });

    test('a redelivery of the same message is only consumed once', async () => {
        const consumer = decorate();

        await consumer.consume(message(1));
        await consumer.consume(message(1));

        expect(inner.messages).toHaveLength(1);
    });

    /**
     * Messages can arrive out of order, or an earlier delivery can be lost. The gap
     * between the stored offset and the version that arrives is replayed from the
     * message repository, and the later redelivery of the skipped version is ignored.
     */
    test('a gap in front of the message is replayed from the repository', async () => {
        const consumer = decorate();
        await messages.persist('1234', [message(1), message(2), message(3)]);

        await consumer.consume(message(3));
        await consumer.consume(message(1));
        await consumer.consume(message(2));

        expect(inner.messages.map(m => m.headers['aggregate_root_version'])).toEqual([1, 2, 3]);
    });

    describe('when introduced later', () => {
        test('a stream without a stored offset starts at the message that arrives', async () => {
            const consumer = decorate({introducedLater: true});
            await messages.persist('1234', [message(1), message(2), message(3)]);

            await consumer.consume(message(3));
            await consumer.consume(message(2));

            expect(inner.messages.map(m => m.headers['aggregate_root_version'])).toEqual([3]);
        });

        test('a gap after the first tracked message is replayed from the repository', async () => {
            const consumer = decorate({introducedLater: true});
            await messages.persist('1234', [message(1), message(2), message(3), message(4), message(5)]);

            await consumer.consume(message(3));
            await consumer.consume(message(5));

            expect(inner.messages.map(m => m.headers['aggregate_root_version'])).toEqual([3, 4, 5]);
        });
    });

    test('it refuses messages without an aggregate_root_id header', async () => {
        const consumer = decorate();

        await expect(consumer.consume(createMessage('add', {amount: 1}, {aggregate_root_version: 1})))
            .rejects.toThrow('aggregate_root_id');
    });

    // the offset is stored after the message is consumed, so a failed consumption does not advance it
    it('it consumes the message again after a failed consumption', async () => {
        const consumedVersions: number[] = [];
        let shouldFail = true;
        const consumer = new ExactlyOnceMessageConsumerDecorator<EventsForAutomaticRebuilds>(
            offsets,
            {
                async consume(message) {
                    if (shouldFail) {
                        throw new Error('projection is temporarily unavailable');
                    }

                    consumedVersions.push(Number(message.headers['aggregate_root_version']));
                },
            },
            messages,
            noopTransactions,
        );

        await expect(consumer.consume(message(1))).rejects.toThrow('projection is temporarily unavailable');

        shouldFail = false;
        await consumer.consume(message(1));

        expect(consumedVersions).toEqual([1]);
    });
});
