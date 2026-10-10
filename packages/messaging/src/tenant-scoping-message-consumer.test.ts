import {AsyncLocalStorage} from 'node:async_hooks';
import {composeContextSlots, Context, defineContextSlot} from '@deltic/context';
import type {MessageConsumer} from './index.js';
import {TenantScopingMessageConsumer} from './tenant-scoping-message-consumer.js';
import {createMessage} from './helpers.js';

interface ExampleStream {
    aggregateRootId: string;
    messages: {
        example: {name: string};
    };
}

type TenantContext = {tenant_id: string};

function tenantContext(): Context<TenantContext> {
    return new Context<TenantContext>(new AsyncLocalStorage());
}

/**
 * Consumes two messages that are in flight at the same time, the way a relay with
 * concurrency does, and reports which tenant each of them saw after resuming from an
 * await. The interleaving is driven by explicit gates so there is no timing involved.
 */
async function tenantsObservedDuringOverlappingConsumption(
    context: Context<TenantContext>,
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
            observedAfterResuming[name] = context.get('tenant_id');
        },
    };
    const scoping = new TenantScopingMessageConsumer(context, consumer);

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
        const context = tenantContext();
        let capturedTenant: string | undefined;

        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {
                capturedTenant = context.get('tenant_id');
            },
        };

        const scoping = new TenantScopingMessageConsumer(context, consumer);
        const message = createMessage<ExampleStream>('example', {name: 'test'}, {
            aggregate_root_id: 'abc',
            tenant_id: 'acme',
        });

        await scoping.consume(message);

        expect(capturedTenant).toBe('acme');
    });

    test('it restores the original tenant context after consumption', async () => {
        const context = tenantContext();

        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {},
        };

        const scoping = new TenantScopingMessageConsumer(context, consumer);
        const message = createMessage<ExampleStream>('example', {name: 'test'}, {
            aggregate_root_id: 'abc',
            tenant_id: 'other-tenant',
        });

        const afterwards = await context.run(async () => {
            await scoping.consume(message);

            return context.get('tenant_id');
        }, {tenant_id: 'original-tenant'});

        expect(afterwards).toBe('original-tenant');
    });

    test('it restores the original tenant context when consumption fails', async () => {
        const context = tenantContext();

        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {
                throw new Error('consumption failed');
            },
        };

        const scoping = new TenantScopingMessageConsumer(context, consumer);
        const message = createMessage<ExampleStream>('example', {name: 'test'}, {
            aggregate_root_id: 'abc',
            tenant_id: 'other-tenant',
        });

        const afterwards = await context.run(async () => {
            await expect(scoping.consume(message)).rejects.toThrow('consumption failed');

            return context.get('tenant_id');
        }, {tenant_id: 'original-tenant'});

        expect(afterwards).toBe('original-tenant');
    });

    /**
     * A relay keeps handing messages to the same consumer instance. Every message is
     * scoped to its own tenant, so a failure does not affect how the next message is
     * scoped.
     */
    test('every message is scoped to its own tenant, also after a failure', async () => {
        const context = tenantContext();
        const observedTenants: (string | undefined)[] = [];

        const consumer: MessageConsumer<ExampleStream> = {
            async consume(message) {
                observedTenants.push(context.get('tenant_id'));

                if (message.payload.name === 'fails') {
                    throw new Error('consumption failed');
                }
            },
        };

        const scoping = new TenantScopingMessageConsumer(context, consumer);

        await expect(scoping.consume(createMessage<ExampleStream>('example', {name: 'fails'}, {
            tenant_id: 'tenant-a',
        }))).rejects.toThrow('consumption failed');

        await scoping.consume(createMessage<ExampleStream>('example', {name: 'succeeds'}, {
            tenant_id: 'tenant-b',
        }));

        expect(observedTenants).toEqual(['tenant-a', 'tenant-b']);
    });

    /**
     * The work a relay does between deliveries — writing a dead-letter record, updating
     * a projection, logging — must not run under the tenant of the message that just
     * failed.
     */
    test('it does not leave a tenant behind for work that happens between deliveries', async () => {
        const context = tenantContext();
        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {
                throw new Error('consumption failed');
            },
        };

        const scoping = new TenantScopingMessageConsumer(context, consumer);

        const betweenDeliveries = await context.run(async () => {
            await expect(scoping.consume(createMessage<ExampleStream>('example', {name: 'test'}, {
                tenant_id: 'tenant-a',
            }))).rejects.toThrow('consumption failed');

            return context.get('tenant_id');
        });

        expect(betweenDeliveries).toBeUndefined();
    });

    test('it sets undefined when the message has no tenant_id header', async () => {
        const context = composeContextSlots(
            [
                defineContextSlot<'tenant_id', string>({key: 'tenant_id'}),
                defineContextSlot<'correlation_id', string>({key: 'correlation_id'}),
            ],
            new AsyncLocalStorage(),
        );
        let capturedTenant: string | undefined = 'not-called';

        const consumer: MessageConsumer<ExampleStream> = {
            async consume() {
                capturedTenant = context.get('tenant_id');
            },
        };

        const scoping = new TenantScopingMessageConsumer(context, consumer);
        const message = createMessage<ExampleStream>('example', {name: 'test'}, {
            aggregate_root_id: 'abc',
        });

        await context.run(() => scoping.consume(message), {tenant_id: 'existing-tenant'});

        expect(capturedTenant).toBeUndefined();
    });

    test('messages consumed at the same time each keep their own tenant', async () => {
        const context = tenantContext();

        const observed = await tenantsObservedDuringOverlappingConsumption(context);

        expect(observed).toEqual({first: 'tenant-a', second: 'tenant-b'});
    });
});
