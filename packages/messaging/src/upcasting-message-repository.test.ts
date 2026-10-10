import {UpcastingMessageRepository} from './upcasting.js';
import {MessageRepositoryUsingMemory} from './message-repository-using-memory.js';
import type {MessagesFrom} from './index.js';
import {collect} from './helpers.js';
import {
    type TestVersionedStream,
    testUpcasters,
    makeUserCreatedV1,
    makeUserCreatedV2,
    makeUserCreatedV3,
    makeUserDeleted,
} from './upcasting.stubs.js';

describe('UpcastingMessageRepository', () => {
    let innerRepository: MessageRepositoryUsingMemory<TestVersionedStream>;
    let repository: UpcastingMessageRepository<TestVersionedStream>;

    beforeEach(() => {
        innerRepository = new MessageRepositoryUsingMemory();
        repository = new UpcastingMessageRepository(testUpcasters, innerRepository);
    });

    describe('persist', () => {
        test('passes messages through to inner repository unchanged', async () => {
            // arrange
            const id = 'agg-1';
            const messages: MessagesFrom<TestVersionedStream> = [
                makeUserCreatedV3('alice', 'alice@test.com', 30),
            ];

            // act
            await repository.persist(id, messages);

            // assert
            const stored = await collect(innerRepository.retrieveAllForAggregate(id));
            expect(stored).toHaveLength(1);
            expect(stored[0].payload).toEqual({
                username: 'alice',
                email: 'alice@test.com',
                age: 30,
            });
        });
    });

    describe('retrieveAllForAggregate', () => {
        test('upcasts all messages when retrieving', async () => {
            // arrange
            const id = 'agg-1';
            await innerRepository.persist(id, [
                makeUserCreatedV1('john', 0),
                makeUserCreatedV2('jane', 'jane@test.com', 1),
                makeUserCreatedV3('bob', 'bob@test.com', 25, 2),
            ]);

            // act
            const retrieved = await collect(repository.retrieveAllForAggregate(id));

            // assert
            expect(retrieved).toHaveLength(3);
            expect(retrieved[0].payload).toEqual({
                username: 'john',
                email: 'john@example.com',
                age: 0,
            });
            expect(retrieved[1].payload).toEqual({
                username: 'jane',
                email: 'jane@test.com',
                age: 0,
            });
            expect(retrieved[2].payload).toEqual({
                username: 'bob',
                email: 'bob@test.com',
                age: 25,
            });
        });
    });

    describe('retrieveAllAfterVersion', () => {
        test('upcasts messages after specified version', async () => {
            // arrange
            const id = 'agg-1';
            await innerRepository.persist(id, [
                {...makeUserCreatedV1('first', 0), headers: {aggregate_root_version: 1, schema_version: 0}},
                {...makeUserCreatedV1('second', 0), headers: {aggregate_root_version: 2, schema_version: 0}},
                {...makeUserCreatedV1('third', 0), headers: {aggregate_root_version: 3, schema_version: 0}},
            ]);

            // act
            const retrieved = await collect(repository.retrieveAllAfterVersion(id, 1));

            // assert
            expect(retrieved).toHaveLength(2);
            expect(retrieved[0].payload).toEqual({
                username: 'second',
                email: 'second@example.com',
                age: 0,
            });
            expect(retrieved[1].payload).toEqual({
                username: 'third',
                email: 'third@example.com',
                age: 0,
            });
        });
    });

    describe('retrieveAllUntilVersion', () => {
        test('upcasts messages until specified version', async () => {
            // arrange
            const id = 'agg-1';
            await innerRepository.persist(id, [
                {...makeUserCreatedV1('first', 0), headers: {aggregate_root_version: 1, schema_version: 0}},
                {...makeUserCreatedV1('second', 0), headers: {aggregate_root_version: 2, schema_version: 0}},
                {...makeUserCreatedV1('third', 0), headers: {aggregate_root_version: 3, schema_version: 0}},
            ]);

            // act
            const retrieved = await collect(repository.retrieveAllUntilVersion(id, 3));

            // assert
            expect(retrieved).toHaveLength(2);
            expect(retrieved[0].payload).toEqual({
                username: 'first',
                email: 'first@example.com',
                age: 0,
            });
            expect(retrieved[1].payload).toEqual({
                username: 'second',
                email: 'second@example.com',
                age: 0,
            });
        });
    });

    describe('retrieveBetweenVersions', () => {
        test('upcasts messages between specified versions', async () => {
            // arrange
            const id = 'agg-1';
            await innerRepository.persist(id, [
                {...makeUserCreatedV1('first', 0), headers: {aggregate_root_version: 1, schema_version: 0}},
                {...makeUserCreatedV1('second', 0), headers: {aggregate_root_version: 2, schema_version: 0}},
                {...makeUserCreatedV1('third', 0), headers: {aggregate_root_version: 3, schema_version: 0}},
                {...makeUserCreatedV1('fourth', 0), headers: {aggregate_root_version: 4, schema_version: 0}},
            ]);

            // act
            const retrieved = await collect(repository.retrieveBetweenVersions(id, 1, 4));

            // assert
            expect(retrieved).toHaveLength(2);
            expect(retrieved[0].payload).toEqual({
                username: 'second',
                email: 'second@example.com',
                age: 0,
            });
            expect(retrieved[1].payload).toEqual({
                username: 'third',
                email: 'third@example.com',
                age: 0,
            });
        });
    });

    describe('paginateIds', () => {
        test('passes through to inner repository', async () => {
            // arrange
            await innerRepository.persist('agg-1', [
                {...makeUserDeleted('u1'), headers: {aggregate_root_version: 1, aggregate_root_id: 'agg-1'}},
            ]);
            await innerRepository.persist('agg-2', [
                {...makeUserDeleted('u2'), headers: {aggregate_root_version: 1, aggregate_root_id: 'agg-2'}},
            ]);

            // act
            const paginated = await collect(repository.paginateIds({limit: 10, afterId: undefined, whichMessage: 'last'}));

            // assert
            expect(paginated.map(p => p.id)).toEqual(['agg-1', 'agg-2']);
        });
    });
});
