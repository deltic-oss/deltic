import type {AnyMessageFrom, MessagesFrom} from '@deltic/messaging';
import {
    ExampleUsingHandlerMap,
    ExampleUsingReducerFunc,
    ExampleUsingReducerMap,
    ExampleUsingReflectMetadata,
    type ExampleStream,
    type Member,
} from './example-stream.stubs.js';

const aggregateRootId = 'abcde';
const frank: Member = {id: '1234', name: 'Frank', age: 32};
const renske: Member = {id: '1235', name: 'Renske', age: 29};

async function* streamOf<Stream extends ExampleStream<never>>(
    messages: MessagesFrom<Stream>,
): AsyncGenerator<AnyMessageFrom<Stream>> {
    for (const message of messages) {
        yield message;
    }
}

describe.each([
    ['AggregateRootUsingReflectMetadata', ExampleUsingReflectMetadata],
    ['AggregateRootUsingHandlerMap', ExampleUsingHandlerMap],
    ['AggregateRootUsingReducerMap', ExampleUsingReducerMap],
    ['AggregateRootUsingReducerFunc', ExampleUsingReducerFunc],
] as const)('replaying events into %s', (_name, aggregate) => {
    type AggregateType = typeof aggregate.prototype;
    type Stream = ExampleStream<AggregateType>;

    const memberWasAdded = (member: Member, version: number): AnyMessageFrom<Stream> => ({
        type: 'member_was_added',
        payload: member,
        headers: {aggregate_root_id: aggregateRootId, aggregate_root_version: version},
    });

    /**
     * An event type that the current version of the code does not know about, which is
     * what a consumer runs into after an event type is renamed or a newer writer is
     * deployed alongside an older reader. It cannot be expressed through the stream
     * definition, because the stream definition is exactly what is out of date.
     */
    const eventOfUnknownType = (type: string, version: number): AnyMessageFrom<Stream> =>
        ({
            type,
            payload: {value: 'from the future'},
            headers: {aggregate_root_id: aggregateRootId, aggregate_root_version: version},
        }) as unknown as AnyMessageFrom<Stream>;

    const replay = (...messages: MessagesFrom<Stream>): Promise<AggregateType> =>
        aggregate.reconstituteFromEvents(aggregateRootId, streamOf(messages)) as Promise<AggregateType>;

    test('reproduces the state of the instance that recorded the events', async () => {
        const live = await replay();
        live.addMember(frank);
        live.addMember(renske);
        live.removeMember(frank.id);
        const recorded = live.releaseEvents();

        const replayed = await replay(...recorded);

        expect(replayed.timesMemberWasAdded).toEqual(live.timesMemberWasAdded);
        expect(replayed.aggregateRootVersion()).toEqual(live.aggregateRootVersion());
        expect(replayed.aggregateRootId).toEqual(live.aggregateRootId);
    });

    test('is deterministic, so replaying the same events twice yields the same state', async () => {
        const events = [memberWasAdded(frank, 1), memberWasAdded(renske, 2)];

        const first = await replay(...events);
        const second = await replay(...events);

        expect(first.timesMemberWasAdded).toEqual(second.timesMemberWasAdded);
        expect(first.aggregateRootVersion()).toEqual(second.aggregateRootVersion());
    });

    test('takes the version from the last replayed event', async () => {
        const replayed = await replay(memberWasAdded(frank, 1), memberWasAdded(renske, 2));

        expect(replayed.aggregateRootVersion()).toEqual(2);
    });

    test('reports version zero when there are no events at all', async () => {
        const replayed = await replay();

        expect(replayed.aggregateRootVersion()).toEqual(0);
        expect(replayed.timesMemberWasAdded).toEqual(0);
        expect(replayed.hasUnreleasedEvents()).toBe(false);
    });

    test('skips an event type it has no handler for and still advances the version', async () => {
        const replayed = await replay(
            memberWasAdded(frank, 1),
            eventOfUnknownType('an_event_from_the_future', 2),
            memberWasAdded(renske, 3),
        );

        expect(replayed.timesMemberWasAdded).toEqual(2);
        expect(replayed.aggregateRootVersion()).toEqual(3);
    });

    test('records new events after the version of the last replayed event', async () => {
        const replayed = await replay(memberWasAdded(frank, 1), memberWasAdded(renske, 2));

        replayed.removeMember(frank.id);

        expect(replayed.releaseEvents().map(message => message.headers['aggregate_root_version'])).toEqual([3]);
    });

    test('falls back to version one for events that carry no version header', async () => {
        const withoutVersionHeaders: MessagesFrom<Stream> = [
            {type: 'member_was_added', payload: frank, headers: {}},
            {type: 'member_was_added', payload: renske, headers: {}},
        ];

        const replayed = await replay(...withoutVersionHeaders);

        expect(replayed.timesMemberWasAdded).toEqual(2);
        expect(replayed.aggregateRootVersion()).toEqual(1);
    });

});

describe.each([
    ['AggregateRootUsingHandlerMap', ExampleUsingHandlerMap],
    ['AggregateRootUsingReducerMap', ExampleUsingReducerMap],
] as const)('looking up an event handler in %s', (_name, aggregate) => {
    type AggregateType = typeof aggregate.prototype;
    type Stream = ExampleStream<AggregateType>;

    const eventOfUnknownType = (type: string): AnyMessageFrom<Stream> =>
        ({
            type,
            payload: {value: 'from the future'},
            headers: {aggregate_root_id: aggregateRootId, aggregate_root_version: 1},
        }) as unknown as AnyMessageFrom<Stream>;

    const replay = (...messages: MessagesFrom<Stream>): Promise<AggregateType> =>
        aggregate.reconstituteFromEvents(aggregateRootId, streamOf(messages)) as Promise<AggregateType>;

    test('ignores an event type that matches a key inherited from the object prototype', async () => {
        const replayed = await replay(eventOfUnknownType('__proto__'));

        expect(replayed.aggregateRootVersion()).toEqual(1);
    });
});

describe('looking up an event handler in AggregateRootUsingReducerMap', () => {
    type Stream = ExampleStream<ExampleUsingReducerMap>;

    const replay = (...messages: MessagesFrom<Stream>): Promise<ExampleUsingReducerMap> =>
        ExampleUsingReducerMap.reconstituteFromEvents(aggregateRootId, streamOf(messages));

    test('leaves the state alone for an event type that matches a method on the object prototype', async () => {
        const replayed = await replay({
            type: 'toString',
            payload: {value: 'from the future'},
            headers: {aggregate_root_id: aggregateRootId, aggregate_root_version: 1},
        } as unknown as AnyMessageFrom<Stream>);

        expect(replayed.timesMemberWasAdded).toEqual(0);
    });
});
