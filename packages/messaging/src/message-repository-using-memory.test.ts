import {MessageRepositoryUsingMemory} from './message-repository-using-memory.js';
import type {AnyMessageFrom, MessagesFrom} from './index.js';
import {ValueReadWriterUsingMemory} from '@deltic/context';
import {collect, createMessage} from './helpers.js';

enum ExampleTypes {
    First = 'first',
    Second = 'second',
}

interface ExampleEventStream {
    aggregateRootId: string;
    messages: {
        [ExampleTypes.First]: string;
        [ExampleTypes.Second]: number;
    };
}

describe('InMemoryMessageRepository', () => {
    test('it stores and retrieves messages', async () => {
        const repository = new MessageRepositoryUsingMemory<ExampleEventStream>();
        const firstMessage: AnyMessageFrom<ExampleEventStream> = createMessage<ExampleEventStream>(
            ExampleTypes.First,
            'first',
        );
        const secondMessage: AnyMessageFrom<ExampleEventStream> = createMessage(ExampleTypes.Second, 2);
        await repository.persist('this', [firstMessage, secondMessage]);
        const retrievedMessages: AnyMessageFrom<ExampleEventStream>[] = [];
        for await (const m of repository.retrieveAllForAggregate('this')) {
            retrievedMessages.push(m);
        }
        expect(retrievedMessages).toHaveLength(2);

        const [firstRetrievedMessage, secondRetrievedMessage] = retrievedMessages;
        expect(firstRetrievedMessage.payload).toEqual(firstMessage.payload);
        expect(firstRetrievedMessage.headers['stream_offset']).toEqual(1);
        expect(secondRetrievedMessage.payload).toEqual(secondMessage.payload);
        expect(secondRetrievedMessage.headers['stream_offset']).toEqual(2);
    });

    test('it respects tenant context', async () => {
        // Arrange
        const tenantContext = new ValueReadWriterUsingMemory('abc');
        const repository = new MessageRepositoryUsingMemory<ExampleEventStream>(tenantContext);
        const firstMessage: AnyMessageFrom<ExampleEventStream> = createMessage(ExampleTypes.First, 'first');
        const secondMessage: AnyMessageFrom<ExampleEventStream> = createMessage(ExampleTypes.Second, 2);

        // Act
        await repository.persist('this', [firstMessage, secondMessage]);
        const retrievedMessages: AnyMessageFrom<ExampleEventStream>[] = [];
        tenantContext.forget();
        for await (const m of repository.retrieveAllForAggregate('this')) {
            retrievedMessages.push(m);
        }

        // Assert
        expect(retrievedMessages).toHaveLength(0);
    });

    test('it can clear itself', async () => {
        const repository = new MessageRepositoryUsingMemory<ExampleEventStream>();
        const firstMessage: AnyMessageFrom<ExampleEventStream> = {
            headers: {},
            type: ExampleTypes.First,
            payload: 'first',
        };
        await repository.persist('this', [firstMessage]);
        repository.clear();
        const retrievedMessages: AnyMessageFrom<ExampleEventStream>[] = [];
        for await (const m of repository.retrieveAllForAggregate('this')) {
            retrievedMessages.push(m);
        }
        expect(retrievedMessages).toHaveLength(0);
    });

    test('it exposes the last commit', async () => {
        const repository = new MessageRepositoryUsingMemory<ExampleEventStream>();
        const firstMessage: AnyMessageFrom<ExampleEventStream> = createMessage(ExampleTypes.First, 'first');
        const secondMessage: AnyMessageFrom<ExampleEventStream> = {
            headers: {},
            type: ExampleTypes.Second,
            payload: 2,
        };
        await repository.persist('this', [firstMessage, secondMessage]);
        let lastCommit = repository.lastCommit;
        expect(lastCommit).toHaveLength(2);
        expect(lastCommit.map(m => m.payload)).toEqual([firstMessage.payload, secondMessage.payload]);

        const thirdMessage: AnyMessageFrom<ExampleEventStream> = {
            headers: {},
            type: ExampleTypes.First,
            payload: 'plus 2',
        };
        await repository.persist('this', [thirdMessage]);
        lastCommit = repository.lastCommit;
        expect(lastCommit).toHaveLength(1);
        expect(lastCommit.map(m => m.payload)).toEqual([thirdMessage.payload]);
    });

    test('it can fetch messages between certain offsets', async () => {
        const id = 'this';
        const repository = new MessageRepositoryUsingMemory<ExampleEventStream>();
        // arrange
        const firstMessage: AnyMessageFrom<ExampleEventStream> = createMessage(ExampleTypes.First, 'first', {
            aggregate_root_version: 1,
        });
        const secondMessage: AnyMessageFrom<ExampleEventStream> = createMessage(ExampleTypes.Second, 2, {
            aggregate_root_version: 2,
        });
        const thirdMessage: AnyMessageFrom<ExampleEventStream> = createMessage(ExampleTypes.First, 'first', {
            aggregate_root_version: 3,
        });
        const fourthMessage: AnyMessageFrom<ExampleEventStream> = createMessage(ExampleTypes.Second, 2, {
            aggregate_root_version: 4,
        });
        await repository.persist(id, [firstMessage, secondMessage, thirdMessage, fourthMessage]);

        // act
        const retrievedPayloads: any[] = [];
        for await (const m of repository.retrieveBetweenVersions(id, 1, 4)) {
            retrievedPayloads.push(m.payload);
        }

        // assert
        expect(retrievedPayloads).toHaveLength(2);
        expect(retrievedPayloads[0]).toEqual(secondMessage.payload);
        expect(retrievedPayloads[1]).toEqual(thirdMessage.payload);
    });

    test('it can fetch messages until a certain offset', async () => {
        const id = 'this';
        const repository = new MessageRepositoryUsingMemory<ExampleEventStream>();
        // arrange
        const firstMessage: AnyMessageFrom<ExampleEventStream> = createMessage(ExampleTypes.First, 'first', {
            aggregate_root_version: 1,
        });
        const secondMessage: AnyMessageFrom<ExampleEventStream> = createMessage(ExampleTypes.Second, 2, {
            aggregate_root_version: 2,
        });
        const thirdMessage: AnyMessageFrom<ExampleEventStream> = createMessage(ExampleTypes.First, 'first', {
            aggregate_root_version: 3,
        });
        const fourthMessage: AnyMessageFrom<ExampleEventStream> = createMessage(ExampleTypes.Second, 2, {
            aggregate_root_version: 4,
        });
        await repository.persist(id, [firstMessage, secondMessage, thirdMessage, fourthMessage]);

        // act
        const retrievedPayloads: any[] = [];
        for await (const m of repository.retrieveAllUntilVersion(id, 4)) {
            retrievedPayloads.push(m.payload);
        }

        // assert
        expect(retrievedPayloads).toHaveLength(3);
        expect(retrievedPayloads[0]).toEqual(firstMessage.payload);
        expect(retrievedPayloads[1]).toEqual(secondMessage.payload);
        expect(retrievedPayloads[2]).toEqual(thirdMessage.payload);
    });

    describe('ID pagination', () => {
        let repository: MessageRepositoryUsingMemory<ExampleEventStream>;
        let ids: string[];

        beforeEach(async () => {
            repository = new MessageRepositoryUsingMemory<ExampleEventStream>();
            let id = 0;
            ids = Array(10)
                .fill(0)
                .map(() => String(++id) as ExampleEventStream['aggregateRootId']);
            const inserts: [ExampleEventStream['aggregateRootId'], MessagesFrom<ExampleEventStream>][] = ids.map(id => {
                let index = 0;
                const make = () =>
                    createMessage<ExampleEventStream>(ExampleTypes.First, 'first', {
                        aggregate_root_version: ++index,
                        aggregate_root_id: id,
                    });

                return [id, [make(), make(), make()]];
            });
            for (const [id, messages] of inserts) {
                await repository.persist(id, messages);
            }
        });

        test('it can paginate over ids', async () => {
            const paginated = repository.paginateIds({
                limit: 5,
                afterId: '2',
                whichMessage: 'last',
            });
            const messages = await collect(paginated);
            const collected: string[] = messages.map(m => m.id);
            const lastVersion = messages.map(m => m.version).at(-1);

            expect(lastVersion).toEqual(3);
            expect(collected.length).toEqual(5);
            expect(collected).toEqual(ids.slice(2, 7));
        });

        test('it can paginate over ids, and get the first message', async () => {
            const paginated = repository.paginateIds({
                limit: 5,
                afterId: '2',
                whichMessage: 'first',
            });
            const messages = await collect(paginated);
            const collected: string[] = messages.map(m => m.id);
            const lastVersion = messages.map(m => m.version).at(-1);

            expect(lastVersion).toEqual(1);
            expect(collected.length).toEqual(5);
            expect(collected).toEqual(ids.slice(2, 7));
        });

        test('an unknown afterId yields nothing rather than starting from the beginning', async () => {
            const paginated = repository.paginateIds({limit: 5, afterId: 'does-not-exist'});

            expect(await collect(paginated)).toHaveLength(0);
        });

    });
});
