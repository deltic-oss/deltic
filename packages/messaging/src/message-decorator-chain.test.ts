import type {MessageDecorator, MessagesFrom, StreamDefinition} from './index.js';
import {MessageDecoratorChain} from './message-decorator-chain.js';
import {MessageDecoratorForEventIds} from './decorator-for-event-ids.js';
import {TenantIdMessageDecorator} from './tenant-id-decorator.js';
import {ValueReadWriterUsingMemory} from '@deltic/context';
import {createMessage, messageWithHeader} from './helpers.js';

interface ExampleStream extends StreamDefinition {
    aggregateRootId: string;
    messages: {
        example: {value: string};
    };
}

function headerStamp(key: string, value: string): MessageDecorator<ExampleStream> {
    return {
        decorate(messages: MessagesFrom<ExampleStream>): MessagesFrom<ExampleStream> {
            return messages.map(m => messageWithHeader(m, {key, value: `${m.headers[key] ?? ''}${value}`}));
        },
    };
}

describe('MessageDecoratorChain', () => {
    test('decorators are applied in order, each seeing the output of the previous one', () => {
        const chain = new MessageDecoratorChain<ExampleStream>([
            headerStamp('trail', 'a'),
            headerStamp('trail', 'b'),
            headerStamp('trail', 'c'),
        ]);

        const [decorated] = chain.decorate([createMessage<ExampleStream>('example', {value: 'payload'})]);

        expect(decorated.headers['trail']).toEqual('abc');
    });

    test('an empty chain returns the messages unchanged', () => {
        const chain = new MessageDecoratorChain<ExampleStream>([]);
        const messages = [createMessage<ExampleStream>('example', {value: 'payload'})];

        expect(chain.decorate(messages)).toEqual(messages);
    });

    test('it decorates every message in the batch', () => {
        const tenantContext = new ValueReadWriterUsingMemory<string>('acme');
        let nextId = 0;
        const chain = new MessageDecoratorChain<ExampleStream>([
            new MessageDecoratorForEventIds<ExampleStream>(() => `event-${++nextId}`),
            new TenantIdMessageDecorator<ExampleStream>(tenantContext),
        ]);

        const decorated = chain.decorate([
            createMessage<ExampleStream>('example', {value: 'one'}),
            createMessage<ExampleStream>('example', {value: 'two'}),
        ]);

        expect(decorated.map(m => m.headers['event_id'])).toEqual(['event-1', 'event-2']);
        expect(decorated.map(m => m.headers['tenant_id'])).toEqual(['acme', 'acme']);
    });

    /**
     * Decorating happens on messages a caller may still hold on to, for instance to
     * persist them in an event store. The originals must not be modified.
     */
    test('the messages handed to the chain are not modified', () => {
        const chain = new MessageDecoratorChain<ExampleStream>([
            new MessageDecoratorForEventIds<ExampleStream>(() => 'event-1'),
        ]);
        const original = createMessage<ExampleStream>('example', {value: 'payload'});

        chain.decorate([original]);

        expect(original.headers['event_id']).toBeUndefined();
    });
});
