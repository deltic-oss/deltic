import {
    composeContextSlots,
    Context,
    type ContextStore,
    ContextMismatchDetected,
    defineContextSlot,
    ContextStoreUsingMemory,
    ValueReadWriterUsingContext,
    UnableToResolveValue,
} from './index.js';
import {AsyncLocalStorage} from 'node:async_hooks';

interface MyContext {
    name: string;
    age: number;
    tenant_id: string;
    value: string;
}

describe.each([
    ['static', () => new ContextStoreUsingMemory<MyContext>()],
    ['async_hooks', () => new AsyncLocalStorage<Partial<MyContext>>()],
] as const)('@deltic/context - %s', (_name, factory) => {
    let contextStore: ContextStore<MyContext>;
    let context: Context<MyContext>;
    let tenantContext: ValueReadWriterUsingContext<'tenant_id', string>;
    const tenantOne = 'one';
    const tenantTwo = 'two';

    beforeEach(() => {
        contextStore = factory();
        context = new Context(contextStore, undefined, {
            value: 'default',
        });
        tenantContext = new ValueReadWriterUsingContext<'tenant_id', string>(context, 'tenant_id');
    });

    test('running with different scope', async () => {
        let store: Partial<MyContext> | undefined;

        await contextStore.run(
            {
                name: 'Other',
                age: 128,
            },
            async () => {
                store = contextStore.getStore();
            },
        );

        expect(store).toEqual({name: 'Other', age: 128});
    });

    test('getting specific values', async () => {
        let name: string | undefined;
        let age: number | undefined;

        await context.run(
            async () => {
                const scoped = context.context();
                name = scoped.name;
                age = scoped.age;
            },
            {
                name: 'Frank',
                age: 16,
            },
        );

        expect(name).toEqual('Frank');
        expect(age).toEqual(16);
    });

    test('getting the full context', async () => {
        let values: Partial<MyContext> = {};

        await context.run(async () => {
            values = context.context();
        });


        // change the context when running with additional context
        await context.run(async () => {
            values = context.context();
        }, {value: 'changed'});

        expect(values).toEqual({
            value: 'changed',
        });

        values = context.context();

        expect(values).toEqual({});
    });

    test('attaching additional context', async () => {
        let name: string | undefined;
        let age: number | undefined;

        await context.run(
            async () => {
                context.attach({
                    name: 'Frank',
                });
                name = context.get('name');
                age = context.get('age');
            },
            {
                age: 37,
            },
        );

        expect(name).toEqual('Frank');
        expect(age).toEqual(37);
    });

    test('nested runs inherit parent context values', async () => {
        let name: string | undefined;
        let age: number | undefined;

        await context.run(
            async () => {
                await context.run(
                    async () => {
                        name = context.get('name');
                        age = context.get('age');
                    },
                    {
                        name: 'Jane',
                    },
                );
            },
            {
                name: 'Frank',
                age: 37,
            },
        );

        expect(name).toEqual('Jane');
        expect(age).toEqual(37); // inherited from parent
    });

    test('using tenant context', async () => {
        let tenantId: string | undefined;

        await context.run(
            async () => {
                tenantId = tenantContext.mustResolve();
            },
            {
                tenant_id: 'what is up',
            },
        );

        expect(tenantId).toEqual('what is up');
    });

    test('failing to resolve the tenant identifier', async () => {
        await context.run(async () => {
            expect(() => tenantContext.mustResolve()).toThrow(UnableToResolveValue);
        });
    });

    test('when a valid tenant ID is set, does not throw', async () => {
        await context.run(async () => {
            tenantContext.use(tenantOne);
            expect(() => tenantContext.preventMismatch(tenantOne)).not.toThrow();
        });
    });

    test('when tenant ID is not set, throws UnableToResolveTenantContext', async () => {
        await context.run(async () => {
            tenantContext.use(undefined);
            expect(() => tenantContext.preventMismatch(tenantOne)).toThrow(new UnableToResolveValue());
        });
    });

    test('when resolved tenant ID does not match given organization ID, throws expected error', async () => {
        await context.run(async () => {
            tenantContext.use(tenantTwo);

            expect(() => tenantContext.preventMismatch(tenantOne)).toThrow(
                ContextMismatchDetected.for(
                    tenantTwo,
                    tenantOne,
                ),
            );
        });
    });
});

// ============================================================================
// Composite Context Tests
// ============================================================================

interface CompositeTestContext {
    tenant_id: string;
    user_id: string;
    trace_id: string;
}

describe.each([
    ['StaticContextStore', () => new ContextStoreUsingMemory<CompositeTestContext>()],
    ['AsyncLocalStorage', () => new AsyncLocalStorage<Partial<CompositeTestContext>>()],
] as const)('composeContextSlots - %s', (_name, storeFactory) => {
    // Define slots for testing
    const tenantSlot = defineContextSlot<'tenant_id', string>({key: 'tenant_id'});
    const userSlot = defineContextSlot({key: 'user_id', defaultValue: () => 'anonymous'});
    const traceSlot = defineContextSlot({key: 'trace_id', defaultValue: () => 'generated-trace-id'});

    test('defineContextSlot creates a slot with key', () => {
        expect(tenantSlot.key).toEqual('tenant_id');
        expect(tenantSlot.defaultValue).toBeUndefined();
    });

    test('defineContextSlot creates a slot with key and default value', () => {
        expect(userSlot.key).toEqual('user_id');
        expect(userSlot.defaultValue).toBeDefined();
        expect(userSlot.defaultValue!()).toEqual('anonymous');
    });

    test('composeContextSlots returns a Context', () => {
        const ctx = composeContextSlots(
            [tenantSlot, userSlot],
            storeFactory(),
        );

        expect(ctx).toBeInstanceOf(Context);
    });

    test('run applies default values', async () => {
        const ctx = composeContextSlots(
            [tenantSlot, userSlot, traceSlot],
            storeFactory(),
        );

        await ctx.run(async () => {
            expect(ctx.get('tenant_id')).toEqual('acme');
            expect(ctx.get('user_id')).toEqual('anonymous');
            expect(ctx.get('trace_id')).toEqual('generated-trace-id');
        }, {tenant_id: 'acme'});
    });

    test('slots without defaults remain undefined', async () => {
        const ctx = composeContextSlots(
            [tenantSlot, userSlot],
            storeFactory(),
        );

        await ctx.run(async () => {
            expect(ctx.get('tenant_id')).toBeUndefined();
            expect(ctx.get('user_id')).toEqual('frank');
        }, {user_id: 'frank'});
    });

    test('nested run inherits parent values', async () => {
        const ctx = composeContextSlots(
            [tenantSlot, userSlot, traceSlot],
            storeFactory(),
        );

        await ctx.run(async () => {
            await ctx.run(async () => {
                // tenant and trace inherited from parent
                expect(ctx.get('tenant_id')).toEqual('acme');
                expect(ctx.get('trace_id')).toEqual('trace-1');
                // user overridden
                expect(ctx.get('user_id')).toEqual('frank');
            }, {user_id: 'frank'});

            // parent context unchanged
            expect(ctx.get('user_id')).toEqual('admin');
        }, {tenant_id: 'acme', user_id: 'admin', trace_id: 'trace-1'});
    });

    test('defaults are re-evaluated on each run', async () => {
        let counter = 0;
        const counterSlot = defineContextSlot({
            key: 'counter',
            defaultValue: () => ++counter,
            inherited: false});

        const ctx = composeContextSlots([counterSlot]);

        await ctx.run(async () => {
            expect(ctx.get('counter')).toEqual(1);
        });

        await ctx.run(async () => {
            expect(ctx.get('counter')).toEqual(2);
        });
    });

    test('context.get returns value', async () => {
        const ctx = composeContextSlots(
            [tenantSlot],
            storeFactory(),
        );

        await ctx.run(async () => {
            expect(ctx.get('tenant_id')).toEqual('acme');
        }, {tenant_id: 'acme'});
    });

    test('context.attach updates value', async () => {
        const ctx = composeContextSlots(
            [tenantSlot],
            storeFactory(),
        );

        await ctx.run(async () => {
            ctx.attach({tenant_id: 'other-tenant'});
            expect(ctx.get('tenant_id')).toEqual('other-tenant');
        }, {tenant_id: 'acme'});
    });

    test('context.context returns full context snapshot', async () => {
        const ctx = composeContextSlots(
            [tenantSlot, userSlot],
            storeFactory(),
        );

        await ctx.run(async () => {
            const snapshot = ctx.context();
            expect(snapshot).toHaveProperty('tenant_id', 'acme');
            expect(snapshot).toHaveProperty('user_id', 'anonymous');
        }, {tenant_id: 'acme'});
    });

    test('TenantContext can be created from composed context', async () => {
        const ctx = composeContextSlots(
            [tenantSlot],
            storeFactory(),
        );

        const tenantContext = new ValueReadWriterUsingContext(ctx, 'tenant_id');

        await ctx.run(async () => {
            expect(tenantContext.resolve()).toEqual('acme');
            expect(tenantContext.mustResolve()).toEqual('acme');
        }, {tenant_id: 'acme'});
    });

    test('explicit values override inherited in nested runs', async () => {
        const ctx = composeContextSlots(
            [tenantSlot, userSlot],
            storeFactory(),
        );

        await ctx.run(async () => {
            await ctx.run(async () => {
                expect(ctx.get('tenant_id')).toEqual('other-tenant');
                expect(ctx.get('user_id')).toEqual('admin'); // inherited
            }, {tenant_id: 'other-tenant'});
        }, {tenant_id: 'acme', user_id: 'admin'});
    });

    test('non-inherited slots get fresh defaults in nested runs', async () => {
        let callCount = 0;
        const sessionSlot = defineContextSlot({key: 'session', defaultValue: () => ({id: ++callCount}), inherited: false});
        const ctx = composeContextSlots(
            [tenantSlot, sessionSlot],
            storeFactory(),
        );

        await ctx.run(async () => {
            const outerSession = ctx.get('session');
            expect(outerSession).toEqual({id: 1});

            await ctx.run(async () => {
                const innerSession = ctx.get('session');
                // non-inherited slot gets a fresh default, not the parent's value
                expect(innerSession).toEqual({id: 2});
                // inherited slot still carries over
                expect(ctx.get('tenant_id')).toEqual('acme');
            });

            // parent context unchanged
            expect(ctx.get('session')).toEqual({id: 1});
        }, {tenant_id: 'acme'});
    });

    test('non-inherited slots can still be explicitly provided in nested runs', async () => {
        const sessionSlot = defineContextSlot({key: 'session', defaultValue: () => 'default-session', inherited: false});
        const ctx = composeContextSlots(
            [tenantSlot, sessionSlot],
            storeFactory(),
        );

        await ctx.run(async () => {
            expect(ctx.get('session')).toEqual('outer-session');

            await ctx.run(async () => {
                // explicitly provided overrides even for non-inherited slots
                expect(ctx.get('session')).toEqual('inner-session');
            }, {session: 'inner-session'});
        }, {session: 'outer-session'});
    });

    test('defaults are only resolved when needed', async () => {
        let defaultCallCount = 0;
        const lazySlot = defineContextSlot({key: 'lazy', defaultValue: () => {
            defaultCallCount++;
            return 'lazy-default';
        }});
        const ctx = composeContextSlots([lazySlot]);

        // when a value is provided, the default should not be resolved
        await ctx.run(async () => {
            expect(ctx.get('lazy')).toEqual('provided');
        }, {lazy: 'provided'});

        expect(defaultCallCount).toEqual(0);

        // when no value is provided, the default should be resolved
        await ctx.run(async () => {
            expect(ctx.get('lazy')).toEqual('lazy-default');
        });

        expect(defaultCallCount).toEqual(1);
    });

    test('defaults are not resolved when value is inherited', async () => {
        let defaultCallCount = 0;
        const lazySlot = defineContextSlot({key: 'lazy', defaultValue: () => {
            defaultCallCount++;
            return 'lazy-default';
        }});
        const ctx = composeContextSlots([lazySlot]);

        await ctx.run(async () => {
            expect(defaultCallCount).toEqual(1); // resolved for outer run

            await ctx.run(async () => {
                // inherited from parent, default should not be called again
                expect(ctx.get('lazy')).toEqual('lazy-default');
            });

            expect(defaultCallCount).toEqual(1); // still 1, not called again
        });
    });

    test('defineContextSlot defaults inherited to true', () => {
        const slot = defineContextSlot<'key', string>({key: 'key'});
        expect(slot.inherited).toEqual(true);
    });

    test('defineContextSlot respects inherited option', () => {
        const slot = defineContextSlot<'key', string>({key: 'key', inherited: false});
        expect(slot.inherited).toEqual(false);
    });
});
