import 'reflect-metadata';
import {AggregateServiceDispatcher} from './aggregate-service-dispatcher.js';
import {
    ExampleAggregateRoot,
    type ExampleAggregateRootId,
    type ExampleStream,
    type Member,
} from './example-stream.stubs.js';
import {createTestTooling} from '@deltic/event-sourcing/test-tooling';
import type {AggregateRepository} from '@deltic/event-sourcing';
import {InputNotSupported} from './index.js';
import {ServiceLocking} from './locking-decorator.js';
import {MutexUsingMemory} from '@deltic/mutex/memory';

interface ExampleCommand {
    id: ExampleAggregateRootId;
}

interface AddMember extends ExampleCommand {
    member: Member;
}

interface ExampleService {
    add: {payload: AddMember; response: string};
}

const {when, then, createMessage} = createTestTooling<ExampleStream, ExampleService>(
    'abcde',
    ExampleAggregateRoot,
    createService,
);

function createService(context: {repository: AggregateRepository<ExampleStream>}) {
    return new AggregateServiceDispatcher<ExampleService, ExampleStream>(
        {
            add: async (aggregate, input) => {
                aggregate.addMember(input.member);

                return input.member.id;
            },
        },
        context.repository,
        (command: ExampleCommand) => command.id,
    );
}

describe('AggregateServiceBus', () => {
    test('should fetch an aggregate and delegate to the handler', async () => {
        const frank = {
            id: '1234',
            name: 'Frank',
            age: 35,
        };
        const response = await when('add', {
            id: 'aggregate-id',
            member: frank,
        });

        expect(response).toBe('1234');

        then(createMessage('member_was_added', frank));
    });
});

type RecordedMessages = ReturnType<ExampleAggregateRoot['releaseEvents']>;

class AggregateRepositoryUsingMemory implements AggregateRepository<ExampleStream> {
    public readonly streams: Map<ExampleAggregateRootId, RecordedMessages> = new Map();
    public readonly retrievals: ExampleAggregateRootId[] = [];
    public readonly persists: ExampleAggregateRootId[] = [];
    public failPersistWith: Error | undefined = undefined;

    async retrieve(id: ExampleAggregateRootId): Promise<ExampleAggregateRoot> {
        this.retrievals.push(id);
        const messages = this.streams.get(id) ?? [];

        return ExampleAggregateRoot.reconstituteFromEvents(
            id,
            (async function* () {
                for (const message of messages) {
                    yield message;
                }
            })(),
        );
    }

    async retrieveAtVersion(id: ExampleAggregateRootId): Promise<ExampleAggregateRoot> {
        return this.retrieve(id);
    }

    async persist(aggregate: ExampleAggregateRoot): Promise<void> {
        this.persists.push(aggregate.aggregateRootId);

        if (this.failPersistWith) {
            throw this.failPersistWith;
        }

        const events = aggregate.releaseEvents();
        const stream = this.streams.get(aggregate.aggregateRootId) ?? [];
        this.streams.set(aggregate.aggregateRootId, stream.concat(events));
    }

    eventTypesFor(id: ExampleAggregateRootId): string[] {
        return (this.streams.get(id) ?? []).map(message => String(message.type));
    }
}

interface MemberService {
    add_member: {payload: {id: ExampleAggregateRootId; member: Member}; response: string};
    count_members: {payload: {id: ExampleAggregateRootId}; response: number};
    fail_after_recording: {payload: {id: ExampleAggregateRootId; member: Member}; response: void};
}

describe('AggregateServiceDispatcher', () => {
    const frank: Member = {id: '1234', name: 'Frank', age: 35};
    const domainFailure = new Error('the domain said no');
    let repository: AggregateRepositoryUsingMemory;
    let resolveAggregateId: (command: {id: ExampleAggregateRootId}) => ExampleAggregateRootId;
    let service: AggregateServiceDispatcher<MemberService, ExampleStream>;

    beforeEach(() => {
        repository = new AggregateRepositoryUsingMemory();
        resolveAggregateId = command => command.id;
        service = new AggregateServiceDispatcher<MemberService, ExampleStream>(
            {
                add_member: async (aggregate, input) => {
                    aggregate.addMember(input.member);

                    return input.member.id;
                },
                // handlers are allowed to be synchronous
                count_members: (aggregate) => aggregate.timesMemberWasAdded,
                fail_after_recording: async (aggregate, input) => {
                    aggregate.addMember(input.member);

                    throw domainFailure;
                },
            },
            repository,
            command => resolveAggregateId(command),
        );
    });

    test('recorded events are persisted before the dispatch resolves', async () => {
        const response = await service.handle({type: 'add_member', payload: {id: 'group-1', member: frank}});

        expect(response).toEqual('1234');
        expect(repository.persists).toEqual(['group-1']);
        expect(repository.eventTypesFor('group-1')).toEqual(['member_was_added']);
    });

    test('the aggregate is not persisted when the handler records nothing', async () => {
        const response = await service.handle({type: 'count_members', payload: {id: 'group-1'}});

        expect(response).toEqual(0);
        expect(repository.retrievals).toEqual(['group-1']);
        expect(repository.persists).toEqual([]);
    });

    test('the id resolver receives the payload of the input', async () => {
        const received: unknown[] = [];
        resolveAggregateId = command => {
            received.push(command);

            return `group-for-${command.id}`;
        };

        await service.handle({type: 'add_member', payload: {id: 'group-1', member: frank}});

        expect(received).toEqual([{id: 'group-1', member: frank}]);
        expect(repository.retrievals).toEqual(['group-for-group-1']);
        expect(repository.persists).toEqual(['group-for-group-1']);
    });

    test('the repository is left untouched when the id resolver throws', async () => {
        const failure = new Error('missing aggregate id');
        resolveAggregateId = () => {
            throw failure;
        };

        await expect(
            service.handle({type: 'add_member', payload: {id: 'group-1', member: frank}}),
        ).rejects.toThrow(failure);
        expect(repository.retrievals).toEqual([]);
        expect(repository.persists).toEqual([]);
    });

    test('events recorded before the handler threw are still persisted', async () => {
        await expect(
            service.handle({type: 'fail_after_recording', payload: {id: 'group-1', member: frank}}),
        ).rejects.toThrow(domainFailure);

        expect(repository.eventTypesFor('group-1')).toEqual(['member_was_added']);
    });

    // see .claude-work/issues/service-dispatcher-persist-failure-hides-handler-error.md
    it.fails('reports the handler error when persisting the recorded events also fails', async () => {
        repository.failPersistWith = new Error('the database is gone');

        await expect(
            service.handle({type: 'fail_after_recording', payload: {id: 'group-1', member: frank}}),
        ).rejects.toThrow(domainFailure);
    });

    // see .claude-work/issues/service-dispatcher-aggregate-dispatcher-unsupported-input.md
    it.fails('rejects with InputNotSupported when no handler is registered for the input type', async () => {
        await expect(
            service.handle({type: 'remove_member', payload: {id: 'group-1'}} as never),
        ).rejects.toThrow(InputNotSupported);
    });

    // see .claude-work/issues/service-dispatcher-prototype-chain-handler-lookup.md
    it.fails('rejects an input type that is only present on the prototype of the handler map', async () => {
        for (const type of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
            await expect(
                service.handle({type, payload: {id: 'group-1', member: frank}} as never),
            ).rejects.toThrow(InputNotSupported);
        }
    });

    test('commands for the same aggregate are not serialised by the dispatcher itself', async () => {
        await Promise.all([
            service.handle({type: 'add_member', payload: {id: 'group-1', member: frank}}),
            service.handle({type: 'add_member', payload: {id: 'group-1', member: frank}}),
        ]);

        expect(repository.eventTypesFor('group-1')).toEqual(['member_was_added', 'member_was_added']);
    });

    test('wrapping the dispatcher in ServiceLocking serialises commands for the same aggregate', async () => {
        const locked = new ServiceLocking<MemberService, ExampleAggregateRootId>(service, {
            mutex: new MutexUsingMemory<ExampleAggregateRootId>(),
            lockResolver: input => input.payload.id,
        });

        await Promise.all([
            locked.handle({type: 'add_member', payload: {id: 'group-1', member: frank}}),
            locked.handle({type: 'add_member', payload: {id: 'group-1', member: frank}}),
        ]);

        expect(repository.eventTypesFor('group-1')).toEqual(['member_was_added']);
    });
});
