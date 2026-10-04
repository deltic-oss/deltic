import {AsyncLocalStorage} from 'node:async_hooks';
import {Context, type ContextStore, ContextStoreUsingMemory} from '@deltic/context';
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

/**
 * Consumes two messages that are in flight at the same time, the way a relay with
 * concurrency does, and reports which aggregate each of them saw in context after
 * resuming from an await. Gates make the interleaving explicit instead of timed.
 */
async function contextsObservedDuringOverlappingConsumption(
    store: ContextStore<Partial<ExampleContext>>,
): Promise<Record<string, string | undefined>> {
    const context = new Context<ExampleContext>(store);
    const gates: Record<string, PromiseWithResolvers<void>> = {
        first: Promise.withResolvers(),
        second: Promise.withResolvers(),
    };
    const entered: Record<string, PromiseWithResolvers<void>> = {
        first: Promise.withResolvers(),
        second: Promise.withResolvers(),
    };
    const observedAfterResuming: Record<string, string | undefined> = {};

    const consumer: MessageConsumer<ExampleStream> = {
        async consume(message) {
            const name = message.payload.name;
            entered[name].resolve();
            await gates[name].promise;
            observedAfterResuming[name] = context.get('aggregate_root_id');
        },
    };
    const scoping = new RunMessageConsumerInContext(consumer, context, message => ({
        aggregate_root_id: String(message.headers.aggregate_root_id ?? ''),
    }));

    const first = scoping.consume(createMessage<ExampleStream>('example', {name: 'first'}, {
        aggregate_root_id: 'aggregate-a',
    }));
    await entered['first'].promise;
    const second = scoping.consume(createMessage<ExampleStream>('example', {name: 'second'}, {
        aggregate_root_id: 'aggregate-b',
    }));
    await entered['second'].promise;

    gates['first'].resolve();
    await first;
    gates['second'].resolve();
    await second;

    return observedAfterResuming;
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

    /**
     * A context resolver commonly forwards message data straight into the context.
     * That data comes off the wire through JSON.parse, so it can contain an own
     * __proto__ key. It must not be able to smuggle in values under other keys.
     */
    test('a __proto__ key in the resolved context cannot spoof context values', async () => {
        const context = new Context<ExampleContext>(new AsyncLocalStorage<Partial<ExampleContext>>());
        let observed: string | undefined = 'not-called';
        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {
                observed = context.get('custom');
            },
        };
        const hostileContext = JSON.parse(
            '{"__proto__": {"custom": "spoofed"}}',
        ) as Partial<ExampleContext>;

        const scoping = new RunMessageConsumerInContext(consumer, context, () => hostileContext);
        await scoping.consume(createMessage<ExampleStream>('example', {name: 'test'}));

        expect(observed).toBeUndefined();
        expect(({} as {custom?: string}).custom).toBeUndefined();
    });

    /**
     * This is the safe way to scope consumption: an async-local store gives every
     * message its own context, so a relay that consumes several messages at once
     * cannot mix them up.
     */
    test('messages consumed at the same time each keep their own context', async () => {
        const observed = await contextsObservedDuringOverlappingConsumption(
            new AsyncLocalStorage<Partial<ExampleContext>>(),
        );

        expect(observed).toEqual({first: 'aggregate-a', second: 'aggregate-b'});
    });

    /**
     * The in-memory store keeps one mutable context, which is what
     * composeContextSlots() hands out when no store is passed. Overlapping
     * consumption then observes another message's context.
     *
     * The defect is in the store, not in this consumer:
     * see .claude-work/issues/context-memory-store-leaks-between-concurrent-flows.md
     */
    it.fails('an in-memory context store also keeps concurrent messages apart', async () => {
        const observed = await contextsObservedDuringOverlappingConsumption(
            new ContextStoreUsingMemory<Partial<ExampleContext>>(),
        );

        expect(observed).toEqual({first: 'aggregate-a', second: 'aggregate-b'});
    });
});
