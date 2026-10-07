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
     * A relay keeps handing messages to the same consumer instance. Every message is
     * scoped to its own tenant, so a failure does not affect how the next message is
     * scoped.
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
