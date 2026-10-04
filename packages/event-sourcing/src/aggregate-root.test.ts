import {ServiceDispatcher} from '@deltic/service-dispatcher';
import {
    ExampleUsingReflectMetadata,
    ExampleUsingHandlerMap,
    ExampleUsingReducerMap,
    ExampleUsingReducerFunc,
    type ExampleAggregateRootId,
    type ExampleStream,
    type Member,
} from './example-stream.stubs.js';
import type {AggregateRepository} from '@deltic/event-sourcing';
import {createTestTooling} from './test-tooling.js';

interface ExampleService {
    add_member: {
        payload: {
            id: ExampleAggregateRootId;
            member: Member;
        };
        response: string;
    };
    throw_error: {
        payload: {
            id: ExampleAggregateRootId;
        };
        response: void;
    };
}

describe.each([
    ['AggregateRootUsingReflectMetadata', ExampleUsingReflectMetadata],
    ['ExampleUsingHandlerMap', ExampleUsingHandlerMap],
    ['ExampleUsingReducerMap', ExampleUsingReducerMap],
    ['ExampleUsingReducerFunc', ExampleUsingReducerFunc],
] as const)('Example aggregate root testing for ', (_name: string, aggregate) => {
    type AggregateType = typeof aggregate.prototype;
    const frank: Member = {id: '1234', name: 'Frank', age: 32};
    const renske: Member = {id: '1235', name: 'Renske', age: 29};
    const {
        id,
        given,
        when,
        whenAggregate,
        then,
        expectError,
        createMessage,
        repository,
        retrieveEntity,
        emittedEventsWithHeaders,
        testClock,
    } = createTestTooling<ExampleStream<AggregateType>, ExampleService>('abcde', aggregate, createService);

    function createService(context: {repository: AggregateRepository<ExampleStream<AggregateType>>}) {
        return new ServiceDispatcher<ExampleService>({
            add_member: async payload => {
                const aggregate = await context.repository.retrieve(payload.id);

                aggregate.addMember(payload.member);

                await context.repository.persist(aggregate);

                return payload.member.id;
            },
            throw_error: async payload => {
                const aggregate = await context.repository.retrieve(payload.id);

                try {
                    aggregate.throwAnError(new Error('what the hell'));
                } finally {
                    await context.repository.persist(aggregate);
                }
            },
        });
    }

    test('sets time of recording unless already in headers', async () => {
        await whenAggregate(async ({aggregateRoot}) => {
            // This command does not set the time of recording header
            aggregateRoot.addMember(frank);
            // This command DOES set the time of recording header
            aggregateRoot.removeMember(frank.id);
        });

        const events = emittedEventsWithHeaders();
        expect(events[0].headers['time_of_recording']).toEqual(testClock.date().toISOString());
        expect(events[0].headers['time_of_recording_ms']).toEqual(testClock.now());
        expect(events[1].headers['time_of_recording']).toEqual(testClock.date().toISOString());
        expect(events[1].headers['time_of_recording_ms']).toEqual(testClock.now());
    });

    test('adding a member through a command', async () => {
        await when('add_member', {
            id,
            member: frank,
        });
        then(createMessage('member_was_added', frank));
    });

    test('Causing an error with a command', async () => {
        expectError(new Error('what the hell'));
        await when('throw_error', {id});
    });

    test('adding a member that is already part of the group', async () => {
        given(createMessage('member_was_added', frank));
        await whenAggregate(async ({aggregateRoot}) => {
            aggregateRoot.addMember(frank);
        });
        then();
    });

    test('An aggregate root maintains a version', async () => {
        await whenAggregate(async ({aggregateRoot}) => {
            expect(aggregateRoot.aggregateRootVersion()).toEqual(0);
            aggregateRoot.addMember(frank);
            expect(aggregateRoot.aggregateRootVersion()).toEqual(1);
            aggregateRoot.addMember(renske);
            expect(aggregateRoot.aggregateRootVersion()).toEqual(2);
        });
    });

    test('An aggregate does not need to have a handler for an event', async () => {
        await whenAggregate(async ({aggregateRoot}) => {
            aggregateRoot.recordInsignificantEvent('something');
            aggregateRoot.recordInsignificantEvent('something else');
        });

        then(createMessage('nothing_happened', 'something'), createMessage('nothing_happened', 'something else'));
    });

    test('Adding a member', async () => {
        await whenAggregate(async ({aggregateRoot}) => {
            aggregateRoot.addMember(frank);
        });
        then(createMessage('member_was_added', frank));

        const aggregateRoot = await retrieveEntity();
        expect(aggregateRoot.timesMemberWasAdded).toEqual(1);
    });

    test('Adding multiple members', async () => {
        await whenAggregate(async ({aggregateRoot}) => {
            aggregateRoot.addMember(frank);
            aggregateRoot.addMember(renske);
        });

        then(createMessage('member_was_added', frank), createMessage('member_was_added', renske));

        const aggregateRoot = await retrieveEntity();
        expect(aggregateRoot.timesMemberWasAdded).toEqual(2);
    });

    test('Removing a member', async () => {
        given(createMessage('member_was_added', frank));
        await whenAggregate(async ({aggregateRoot}) => {
            aggregateRoot.removeMember(frank.id);
        });
        then(createMessage('member_was_removed', {id: frank.id}));

        const entity = await retrieveEntity();
        expect(entity.aggregateRootVersion()).toEqual(2);
    });

    test('Removing a member that does not exist', async () => {
        await whenAggregate(async ({aggregateRoot}) => {
            aggregateRoot.removeMember(frank.id);
        });
        then();
    });

    test('Causing an error', async () => {
        const error = new Error('what the hell');
        expectError(error);
        await whenAggregate(async ({aggregateRoot}) => {
            aggregateRoot.throwAnError(error);
        });
    });

    test('Causing an error that is expected by its type', async () => {
        expectError(TypeError);
        await whenAggregate(async ({aggregateRoot}) => {
            aggregateRoot.throwAnError(new TypeError('what the hell'));
        });
    });

    test('A command that records nothing emits no events, even after one that did', async () => {
        await when('add_member', {id, member: frank});
        then(createMessage('member_was_added', frank));

        await when('add_member', {id, member: frank});
        then();
    });

    test('An aggregate action that records nothing emits no events, even after one that did', async () => {
        await whenAggregate(async ({aggregateRoot}) => {
            aggregateRoot.addMember(frank);
        });
        then(createMessage('member_was_added', frank));

        await whenAggregate(async ({aggregateRoot}) => {
            aggregateRoot.addMember(frank);
        });
        then();
    });

    test('Fetching an entity at a specific version', async () => {
        given(createMessage('member_was_added', frank), createMessage('member_was_added', renske));

        const entity = await repository.retrieveAtVersion(id, 1);

        expect(entity.aggregateRootVersion()).toEqual(1);
    });
});
