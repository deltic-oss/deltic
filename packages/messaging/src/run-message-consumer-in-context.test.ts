import {Context, ContextStoreUsingMemory} from '@deltic/context';
import type {MessageConsumer} from './index.js';
import {RunMessageConsumerInContext} from './run-message-consumer-in-context.js';
import {createMessage} from './helpers.js';

interface ExampleStream {
    aggregateRootId: string;
    messages: {
        example: {name: string};
    };
}

interface ExampleContext {
    aggregate_root_id: string;
    custom: string;
}

describe('RunMessageConsumerInContext', () => {
    test('it runs the inner consumer within a context scope', async () => {
        const store = new ContextStoreUsingMemory<ExampleContext>();
        const context = new Context<ExampleContext>(store);
        let capturedContext: Partial<ExampleContext> | undefined;

        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {
                capturedContext = context.context();
            },
        };

        const scoping = new RunMessageConsumerInContext(consumer, context, (message) => ({
            aggregate_root_id: String(message.headers.aggregate_root_id ?? ''),
            custom: 'resolved-value',
        }));

        const message = createMessage<ExampleStream>('example', {name: 'test'}, {aggregate_root_id: 'abc'});
        await scoping.consume(message);

        expect(capturedContext).toEqual({
            aggregate_root_id: 'abc',
            custom: 'resolved-value',
        });
    });

    test('it resolves partial context from the message', async () => {
        const store = new ContextStoreUsingMemory<ExampleContext>();
        const context = new Context<ExampleContext>(store);
        let capturedContext: Partial<ExampleContext> | undefined;

        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {
                capturedContext = context.context();
            },
        };

        const scoping = new RunMessageConsumerInContext(consumer, context, (message) => ({
            aggregate_root_id: String(message.headers.aggregate_root_id ?? ''),
        }));

        const message = createMessage<ExampleStream>('example', {name: 'test'}, {aggregate_root_id: 'xyz'});
        await scoping.consume(message);

        expect(capturedContext).toEqual({
            aggregate_root_id: 'xyz',
        });
    });

    test('context is not available after consumption', async () => {
        const store = new ContextStoreUsingMemory<ExampleContext>();
        const context = new Context<ExampleContext>(store);

        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {},
        };

        const scoping = new RunMessageConsumerInContext(consumer, context, () => ({
            custom: 'scoped-value',
        }));

        const message = createMessage<ExampleStream>('example', {name: 'test'}, {aggregate_root_id: 'abc'});
        await scoping.consume(message);

        expect(context.context()).toEqual({});
    });

    test('it propagates errors from the inner consumer', async () => {
        const store = new ContextStoreUsingMemory<ExampleContext>();
        const context = new Context<ExampleContext>(store);

        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {
                throw new Error('consumption failed');
            },
        };

        const scoping = new RunMessageConsumerInContext(consumer, context, () => ({
            custom: 'scoped-value',
        }));

        const message = createMessage<ExampleStream>('example', {name: 'test'}, {aggregate_root_id: 'abc'});

        await expect(scoping.consume(message)).rejects.toThrow('consumption failed');
    });

});
