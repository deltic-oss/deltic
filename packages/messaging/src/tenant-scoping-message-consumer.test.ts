import {AsyncLocalStorage} from 'node:async_hooks';
import {
    composeContextSlots,
    defineContextSlot,
    ValueReadWriterUsingContext,
    ValueReadWriterUsingMemory,
    type ValueReadWriter,
} from '@deltic/context';
import type {MessageConsumer} from './index.js';
import {TenantScopingMessageConsumer} from './tenant-scoping-message-consumer.js';
import {createMessage} from './helpers.js';

interface ExampleStream {
    aggregateRootId: string;
    messages: {
        example: {name: string};
    };
}

/**
 * Consumes two messages that are in flight at the same time, the way a relay with
 * concurrency does, and reports which tenant each of them saw after resuming from an
 * await. The interleaving is driven by explicit gates so there is no timing involved.
 */
async function tenantsObservedDuringOverlappingConsumption(
    tenantContext: ValueReadWriter<string>,
): Promise<Record<string, string | undefined>> {
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
            observedAfterResuming[name] = tenantContext.resolve();
        },
    };
    const scoping = new TenantScopingMessageConsumer(tenantContext, consumer);

    const first = scoping.consume(createMessage<ExampleStream>('example', {name: 'first'}, {
        tenant_id: 'tenant-a',
    }));
    await entered['first'].promise;
    const second = scoping.consume(createMessage<ExampleStream>('example', {name: 'second'}, {
        tenant_id: 'tenant-b',
    }));
    await entered['second'].promise;

    gates['first'].resolve();
    await first;
    gates['second'].resolve();
    await second;

    return observedAfterResuming;
}

describe('TenantScopingMessageConsumer', () => {
    test('it sets the tenant context from the message header', async () => {
        const tenantContext = new ValueReadWriterUsingMemory<string>();
        let capturedTenant: string | undefined;

        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {
                capturedTenant = tenantContext.resolve();
            },
        };

        const scoping = new TenantScopingMessageConsumer(tenantContext, consumer);
        const message = createMessage<ExampleStream>('example', {name: 'test'}, {
            aggregate_root_id: 'abc',
            tenant_id: 'acme',
        });

        await scoping.consume(message);

        expect(capturedTenant).toBe('acme');
    });

    test('it restores the original tenant context after consumption', async () => {
        const tenantContext = new ValueReadWriterUsingMemory<string>();
        tenantContext.use('original-tenant');

        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {},
        };

        const scoping = new TenantScopingMessageConsumer(tenantContext, consumer);
        const message = createMessage<ExampleStream>('example', {name: 'test'}, {
            aggregate_root_id: 'abc',
            tenant_id: 'other-tenant',
        });

        await scoping.consume(message);

        expect(tenantContext.resolve()).toBe('original-tenant');
    });

    /**
     * Documents current behaviour: the message tenant stays in the context when
     * consumption fails. See the it.fails case below for the expected behaviour.
     *
     * see .claude-work/issues/messaging-tenant-context-leaks-on-consumer-failure.md
     */
    test('it leaves the message tenant in the context when consumption fails', async () => {
        const tenantContext = new ValueReadWriterUsingMemory<string>();
        tenantContext.use('original-tenant');

        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {
                throw new Error('consumption failed');
            },
        };

        const scoping = new TenantScopingMessageConsumer(tenantContext, consumer);
        const message = createMessage<ExampleStream>('example', {name: 'test'}, {
            aggregate_root_id: 'abc',
            tenant_id: 'other-tenant',
        });

        await expect(scoping.consume(message)).rejects.toThrow('consumption failed');
        expect(tenantContext.resolve()).toBe('other-tenant');
    });

    // see .claude-work/issues/messaging-tenant-context-leaks-on-consumer-failure.md
    it.fails('it restores the original tenant context when consumption fails', async () => {
        const tenantContext = new ValueReadWriterUsingMemory<string>();
        tenantContext.use('original-tenant');

        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {
                throw new Error('consumption failed');
            },
        };

        const scoping = new TenantScopingMessageConsumer(tenantContext, consumer);
        const message = createMessage<ExampleStream>('example', {name: 'test'}, {
            aggregate_root_id: 'abc',
            tenant_id: 'other-tenant',
        });

        await expect(scoping.consume(message)).rejects.toThrow('consumption failed');
        expect(tenantContext.resolve()).toBe('original-tenant');
    });

    /**
     * A relay keeps handing messages to the same consumer instance. Every message is
     * scoped to its own tenant, so a failure does not affect how the next message is
     * scoped — only the context that remains in between deliveries is wrong.
     */
    test('every message is scoped to its own tenant, also after a failure', async () => {
        const tenantContext = new ValueReadWriterUsingMemory<string>();
        const observedTenants: (string | undefined)[] = [];

        const consumer: MessageConsumer<ExampleStream> = {
            async consume(message) {
                observedTenants.push(tenantContext.resolve());

                if (message.payload.name === 'fails') {
                    throw new Error('consumption failed');
                }
            },
        };

        const scoping = new TenantScopingMessageConsumer(tenantContext, consumer);

        await expect(scoping.consume(createMessage<ExampleStream>('example', {name: 'fails'}, {
            tenant_id: 'tenant-a',
        }))).rejects.toThrow('consumption failed');

        await scoping.consume(createMessage<ExampleStream>('example', {name: 'succeeds'}, {
            tenant_id: 'tenant-b',
        }));

        expect(observedTenants).toEqual(['tenant-a', 'tenant-b']);
    });

    /**
     * The tenant that is in context when consumption starts must be restored before
     * control returns to the caller. Otherwise the work a relay does between
     * deliveries — writing a dead-letter record, updating a projection, logging —
     * runs under the tenant of the message that just failed.
     *
     * see .claude-work/issues/messaging-tenant-context-leaks-on-consumer-failure.md
     */
    it.fails('it does not leave a tenant behind for work that happens between deliveries', async () => {
        const tenantContext = new ValueReadWriterUsingMemory<string>();
        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {
                throw new Error('consumption failed');
            },
        };

        const scoping = new TenantScopingMessageConsumer(tenantContext, consumer);

        await expect(scoping.consume(createMessage<ExampleStream>('example', {name: 'test'}, {
            tenant_id: 'tenant-a',
        }))).rejects.toThrow('consumption failed');

        expect(tenantContext.resolve()).toBeUndefined();
    });

    /**
     * Backing the tenant with an async-local store does not help: consumption mutates
     * the ambient context instead of entering a scope of its own, so both messages
     * still write to the same store object.
     *
     * see .claude-work/issues/messaging-tenant-scope-leaks-between-concurrent-messages.md
     */
    it.fails('an async-local tenant context also keeps concurrent messages apart', async () => {
        const context = composeContextSlots(
            [defineContextSlot<'tenant_id', string>({key: 'tenant_id'})],
            new AsyncLocalStorage(),
        );

        const observed = await context.run(() => tenantsObservedDuringOverlappingConsumption(
            new ValueReadWriterUsingContext(context, 'tenant_id'),
        ));

        expect(observed).toEqual({first: 'tenant-a', second: 'tenant-b'});
    });

    test('it sets undefined when the message has no tenant_id header', async () => {
        const tenantContext = new ValueReadWriterUsingMemory<string>();
        tenantContext.use('existing-tenant');
        let capturedTenant: string | undefined = 'not-called';

        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {
                capturedTenant = tenantContext.resolve();
            },
        };

        const scoping = new TenantScopingMessageConsumer(tenantContext, consumer);
        const message = createMessage<ExampleStream>('example', {name: 'test'}, {
            aggregate_root_id: 'abc',
        });

        await scoping.consume(message);

        expect(capturedTenant).toBeUndefined();
    });
});
