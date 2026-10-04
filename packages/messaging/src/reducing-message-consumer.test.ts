import {ReducingMessageConsumer, routeSomeToReducer} from './reducing-message-consumer.js';
import {KeyValueStoreUsingMemory} from '@deltic/key-value/memory';
import type {AnyMessageFrom, MessagesFrom} from '@deltic/messaging';
import {messageFactory} from '@deltic/messaging/helpers';

interface ReducingProjectionsEvents {
    aggregateRootId: string;
    messages: {
        one: {
            one: number;
        };
        two: {
            two: number;
        };
    };
}

describe('reducing projections', () => {
    const createMessage = messageFactory<ReducingProjectionsEvents>();

    test('it can sum up how many times certain events occur per tenant', async () => {
        const storage = new KeyValueStoreUsingMemory<string, number>();
        const projection = new ReducingMessageConsumer<string, number, ReducingProjectionsEvents>(
            storage,
            message => `${message.headers['tenant-id']}:${message.type}`,
            () => 0,
            async state => state + 1,
        );

        const messages: MessagesFrom<ReducingProjectionsEvents> = [
            // first tenant
            createMessage('two', {two: 1234}, {'tenant-id': '1234'}),
            createMessage('one', {one: 1234}, {'tenant-id': '1234'}),
            createMessage('two', {two: 1234}, {'tenant-id': '1234'}),
            // second tenant
            createMessage('one', {one: 1234}, {'tenant-id': '4321'}),
            createMessage('one', {one: 1234}, {'tenant-id': '4321'}),
            createMessage('one', {one: 1234}, {'tenant-id': '4321'}),
            createMessage('two', {two: 1234}, {'tenant-id': '4321'}),
        ];

        for (const message of messages) {
            await projection.consume(message);
        }

        expect(await storage.retrieve('1234:one')).toEqual(1);
        expect(await storage.retrieve('1234:two')).toEqual(2);
        expect(await storage.retrieve('4321:one')).toEqual(3);
        expect(await storage.retrieve('4321:two')).toEqual(1);
    });

    test('routing to a reducers map', async () => {
        const storage = new KeyValueStoreUsingMemory<string, number>();
        const projection = new ReducingMessageConsumer<string, number, ReducingProjectionsEvents>(
            storage,
            message => message.headers['tenant-id']?.toString() || 'unknown',
            () => 0,
            routeSomeToReducer({
                two: (state, message) => state + message.payload.two,
            }),
        );

        const messages: MessagesFrom<ReducingProjectionsEvents> = [
            // first tenant
            createMessage('two', {two: 5}, {'tenant-id': '1234'}),
            createMessage('one', {one: 1234}, {'tenant-id': '1234'}),
            createMessage('two', {two: 10}, {'tenant-id': '1234'}),
            // second tenant
            createMessage('two', {two: 1}, {'tenant-id': '4321'}),
            createMessage('two', {two: 2}, {'tenant-id': '4321'}),
            createMessage('one', {one: 1234}, {'tenant-id': '4321'}),
            createMessage('two', {two: 3}, {'tenant-id': '4321'}),
        ];

        for (const message of messages) {
            await projection.consume(message);
        }

        expect(await storage.retrieve('1234')).toEqual(15);
        expect(await storage.retrieve('4321')).toEqual(6);
    });

    /**
     * The message type comes off the wire, so it can name a property that every plain
     * object has. Such a type has no reducer registered for it and must leave the state
     * alone, instead of running Object.prototype.toString as if it were a reducer.
     *
     * see .claude-work/issues/messaging-message-type-used-as-unguarded-object-key.md
     */
    it.fails('a message type that names an Object property does not change the state', async () => {
        const storage = new KeyValueStoreUsingMemory<string, number>();
        const projection = new ReducingMessageConsumer<string, number, ReducingProjectionsEvents>(
            storage,
            () => 'total',
            () => 0,
            routeSomeToReducer({
                two: (state, message) => state + message.payload.two,
            }),
        );

        await projection.consume(createMessage('two', {two: 5}));
        await projection.consume({
            type: 'toString',
            payload: {two: 1},
            headers: {},
        } as unknown as AnyMessageFrom<ReducingProjectionsEvents>);

        expect(await storage.retrieve('total')).toEqual(5);
    });

    test('using an object as the key', async () => {
        type ProjectionKey = {
            tenant: string;
            segment: number;
        };
        const storage = new KeyValueStoreUsingMemory<ProjectionKey, number>();
        const projection = new ReducingMessageConsumer<ProjectionKey, number, ReducingProjectionsEvents>(
            storage,
            message => ({
                tenant: message.headers['tenant']?.toString() || 'unknown',
                segment: Number(message.headers['segment']),
            }),
            () => 0,
            routeSomeToReducer({
                one: (state, message) => state + message.payload.one,
            }),
        );

        const messages: MessagesFrom<ReducingProjectionsEvents> = [
            // first tenant
            createMessage('one', {one: 20}, {tenant: '1234', segment: 1}),
            createMessage('one', {one: 30}, {tenant: '1234', segment: 1}),
            createMessage('one', {one: 40}, {tenant: '1234', segment: 2}),
            createMessage('one', {one: 50}, {tenant: '1234', segment: 2}),
            createMessage('two', {two: 5}, {tenant: '1234', segment: 1}),
            createMessage('two', {two: 10}, {tenant: '1234', segment: 1}),
            // second tenant
            createMessage('one', {one: 10}, {tenant: '4321', segment: 1}),
            createMessage('one', {one: 15}, {tenant: '4321', segment: 1}),
        ];

        for (const message of messages) {
            await projection.consume(message);
        }

        expect(await storage.retrieve({tenant: '1234', segment: 1})).toEqual(50);
        expect(await storage.retrieve({tenant: '1234', segment: 2})).toEqual(90);
        expect(await storage.retrieve({tenant: '4321', segment: 1})).toEqual(25);
        expect(await storage.retrieve({tenant: '4321', segment: 2})).toEqual(undefined);
    });
});
