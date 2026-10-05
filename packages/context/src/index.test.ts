import {
    composeContextSlots,
    composeContextSlotsForTesting,
    Context,
    type ContextStore,
    ContextMismatchDetected,
    defineContextSlot,
    ContextStoreUsingMemory,
    type ValueReadWriter,
    ValueReadWriterUsingContext,
    ValueReadWriterUsingMemory,
    UnableToAttachContext,
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
        context = new Context(contextStore);
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

    test('reading context outside of a run scope yields no values', () => {
        expect(context.context()).toEqual({});
        expect(context.get('name')).toBeUndefined();
        expect(tenantContext.resolve()).toBeUndefined();
        expect(() => tenantContext.mustResolve()).toThrow(UnableToResolveValue);
    });

    test('the value produced by the callback is returned', async () => {
        await expect(context.run(async () => 'handled', {name: 'Frank'})).resolves.toEqual('handled');
    });

    test('an error thrown inside a run reaches the caller', async () => {
        const failure = new Error('consumer failed');

        await expect(context.run(async () => {
            throw failure;
        }, {name: 'Frank'})).rejects.toBe(failure);
    });

    test('the surrounding context is restored after a nested run throws', async () => {
        let restored: Partial<MyContext> = {};

        await context.run(async () => {
            await expect(context.run(async () => {
                throw new Error('nested failure');
            }, {name: 'Jane'})).rejects.toThrow('nested failure');

            restored = context.context();
        }, {name: 'Frank', age: 37});

        expect(restored).toEqual({name: 'Frank', age: 37});
        expect(context.context()).toEqual({});
    });

    test('values attached in a nested run stay in that run', async () => {
        let surrounding: Partial<MyContext> = {};

        await context.run(async () => {
            await context.run(async () => {
                context.attach({name: 'Jane'});
            }, {age: 21});

            surrounding = context.context();
        }, {name: 'Frank', age: 37});

        expect(surrounding).toEqual({name: 'Frank', age: 37});
    });

    test('units of work processed one after the other do not inherit each other values', async () => {
        // mirrors RunMessageConsumerInContext handling two messages in sequence
        const observed: Array<Partial<MyContext>> = [];

        for (const tenantId of [tenantOne, tenantTwo]) {
            await context.run(async () => {
                context.attach({name: `handler-${tenantId}`});
                observed.push({...context.context()});
            }, {tenant_id: tenantId});
        }

        expect(observed).toEqual([
            {tenant_id: tenantOne, name: `handler-${tenantOne}`},
            {tenant_id: tenantTwo, name: `handler-${tenantTwo}`},
        ]);
    });

    describe('constructor defaults', () => {
        let defaulting: Context<MyContext>;

        beforeEach(() => {
            defaulting = new Context(factory(), undefined, {value: 'default'});
        });

        test('applies the constructor defaults when a run provides no values', async () => {
            await defaulting.run(async () => {
                expect(defaulting.get('value')).toEqual('default');
                expect(defaulting.context()).toEqual({value: 'default'});
            });
        });

        test('values provided to a run take precedence over the constructor defaults', async () => {
            await defaulting.run(async () => {
                expect(defaulting.get('value')).toEqual('provided');
            }, {value: 'provided'});
        });

        test('a nested run keeps the value its parent decided on instead of the default', async () => {
            await defaulting.run(async () => {
                await defaulting.run(async () => {
                    expect(defaulting.get('value')).toEqual('provided');
                });
            }, {value: 'provided'});
        });

        test('the defaults are not visible outside a run scope', () => {
            expect(defaulting.context()).toEqual({});
            expect(defaulting.get('value')).toBeUndefined();
        });
    });

    test('reports that there is no scope to attach values to', () => {
        expect(() => context.attach({tenant_id: tenantOne})).toThrow(UnableToAttachContext);
    });

    test('a value reader reports that there is no scope to write to', () => {
        expect(() => tenantContext.use(tenantOne)).toThrow(UnableToAttachContext);
        expect(() => tenantContext.forget()).toThrow(UnableToAttachContext);
    });

    test('the scope is gone again once a run has finished', async () => {
        await context.run(async () => {
            context.attach({tenant_id: tenantOne});
        });

        expect(() => context.attach({tenant_id: tenantTwo})).toThrow(UnableToAttachContext);
    });

    test('attaches keys as own properties without replacing the prototype', async () => {
        await context.run(async () => {
            // claims decoded from an untrusted token, `__proto__` survives JSON.parse as an own key
            const claims = JSON.parse('{"name":"attacker","__proto__":{"tenant_id":"other-tenant"}}') as Partial<MyContext>;

            context.attach(claims);

            expect(context.get('tenant_id')).toBeUndefined();
            expect(Object.getPrototypeOf(context.context())).toBe(Object.prototype);
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

    test('a slot without a default and without a value is absent from the context', async () => {
        // ContextMessageDecorator uses `key in context` to decide which headers to write
        const ctx = composeContextSlots(
            [tenantSlot, userSlot],
            storeFactory(),
        );

        await ctx.run(async () => {
            const snapshot = ctx.context();

            expect('tenant_id' in snapshot).toEqual(false);
            expect('user_id' in snapshot).toEqual(true);
        });
    });

    test('an explicitly undefined value suppresses the slot default', async () => {
        const ctx = composeContextSlots(
            [tenantSlot, userSlot],
            storeFactory(),
        );

        await ctx.run(async () => {
            expect(ctx.get('user_id')).toBeUndefined();
            expect('user_id' in ctx.context()).toEqual(true);
        }, {user_id: undefined});
    });

    test('an explicitly undefined value replaces an inherited value', async () => {
        const ctx = composeContextSlots(
            [tenantSlot, userSlot],
            storeFactory(),
        );

        await ctx.run(async () => {
            await ctx.run(async () => {
                expect(ctx.get('tenant_id')).toBeUndefined();
            }, {tenant_id: undefined});

            expect(ctx.get('tenant_id')).toEqual('acme');
        }, {tenant_id: 'acme'});
    });

    test('a forgotten value is not restored from the default in a nested run', async () => {
        // TenantScopingMessageConsumer restores the previous value, which may be undefined
        const ctx = composeContextSlots(
            [tenantSlot, userSlot],
            storeFactory(),
        );
        const userContext = new ValueReadWriterUsingContext(ctx, 'user_id');

        await ctx.run(async () => {
            userContext.forget();

            await ctx.run(async () => {
                expect(ctx.get('user_id')).toBeUndefined();
            });
        });
    });
});

describe('composeContextSlotsForTesting', () => {
    const tenantSlot = defineContextSlot<'tenant_id', string>({key: 'tenant_id'});
    const userSlot = defineContextSlot({key: 'user_id', defaultValue: () => 'anonymous'});

    test('slot defaults are available without entering a run scope', () => {
        const ctx = composeContextSlotsForTesting([tenantSlot, userSlot]);

        expect(ctx.get('user_id')).toEqual('anonymous');
        expect(ctx.get('tenant_id')).toBeUndefined();
    });

    test('values can be attached without entering a run scope', () => {
        const ctx = composeContextSlotsForTesting([tenantSlot, userSlot]);

        ctx.attach({tenant_id: 'acme'});

        expect(ctx.get('tenant_id')).toEqual('acme');
    });

    test('a run inherits the values prepared outside of a scope', async () => {
        const ctx = composeContextSlotsForTesting([tenantSlot, userSlot]);
        ctx.attach({tenant_id: 'acme'});

        await ctx.run(async () => {
            expect(ctx.get('tenant_id')).toEqual('acme');
            expect(ctx.get('user_id')).toEqual('anonymous');
        });
    });

    test('a run does not write back into the prepared context', async () => {
        const ctx = composeContextSlotsForTesting([tenantSlot]);

        await ctx.run(async () => {
            ctx.attach({tenant_id: 'other-tenant'});
        }, {tenant_id: 'acme'});

        expect(ctx.get('tenant_id')).toBeUndefined();
    });

    test('slot defaults are created once for the whole composition', async () => {
        let created = 0;
        const traceSlot = defineContextSlot({key: 'trace_id', defaultValue: () => `trace-${++created}`});
        const ctx = composeContextSlotsForTesting([traceSlot]);

        await ctx.run(async () => {
            expect(ctx.get('trace_id')).toEqual('trace-1');
        });

        await ctx.run(async () => {
            expect(ctx.get('trace_id')).toEqual('trace-1');
        });

        expect(created).toEqual(1);
    });
});

// ============================================================================
// ContextStoreUsingMemory
// ============================================================================

interface RequestContext {
    tenant_id: string;
    user_id: string;
}

describe('ContextStoreUsingMemory', () => {
    let store: ContextStoreUsingMemory<RequestContext>;
    let context: Context<RequestContext>;

    beforeEach(() => {
        store = new ContextStoreUsingMemory<RequestContext>();
        context = new Context<RequestContext>(store);
    });

    test('sequential flows are scoped correctly', async () => {
        const observed: Array<string | undefined> = [];

        for (const tenantId of ['tenant-a', 'tenant-b']) {
            await context.run(async () => {
                await new Promise<void>(resolve => setImmediate(resolve));
                observed.push(context.get('tenant_id'));
            }, {tenant_id: tenantId});
        }

        expect(observed).toEqual(['tenant-a', 'tenant-b']);
        expect(store.getStore()).toBeUndefined();
    });
});

// ============================================================================
// ValueReadWriter contract
// ============================================================================

type TenantValue = string | number;

type ValueScope = {
    readonly values: ValueReadWriter<TenantValue>;
    run<R>(fn: () => Promise<R>): Promise<R>;
};

function contextBackedScope(store: ContextStore<{tenant_id: TenantValue}>): ValueScope {
    const context = new Context<{tenant_id: TenantValue}>(store);

    return {
        values: new ValueReadWriterUsingContext(context, 'tenant_id'),
        run<R>(fn: () => Promise<R>): Promise<R> {
            return context.run(fn);
        },
    };
}

describe.each([
    ['memory', (): ValueScope => ({
        values: new ValueReadWriterUsingMemory<TenantValue>(),
        run<R>(fn: () => Promise<R>): Promise<R> {
            return fn();
        },
    })],
    ['context with async_hooks', (): ValueScope => contextBackedScope(
        new AsyncLocalStorage<Partial<{tenant_id: TenantValue}>>(),
    )],
    ['context with memory store', (): ValueScope => contextBackedScope(
        new ContextStoreUsingMemory<{tenant_id: TenantValue}>({}),
    )],
] as const)('ValueReadWriter contract - %s', (_name, factory) => {
    let scope: ValueScope;

    beforeEach(() => {
        scope = factory();
    });

    test('a value that was never used cannot be resolved', async () => {
        await scope.run(async () => {
            expect(scope.values.resolve()).toBeUndefined();
            expect(() => scope.values.mustResolve()).toThrow(UnableToResolveValue);
        });
    });

    test('a value in use can be resolved', async () => {
        await scope.run(async () => {
            scope.values.use('acme');

            expect(scope.values.resolve()).toEqual('acme');
            expect(scope.values.mustResolve()).toEqual('acme');
        });
    });

    test('the number zero counts as a value in use', async () => {
        await scope.run(async () => {
            scope.values.use(0);

            expect(scope.values.resolve()).toEqual(0);
            expect(scope.values.mustResolve()).toEqual(0);
        });
    });

    test('an empty string counts as a value in use', async () => {
        // consumers guard with `if (tenantId)`, so it matters that this resolves
        await scope.run(async () => {
            scope.values.use('');

            expect(scope.values.resolve()).toEqual('');
            expect(scope.values.mustResolve()).toEqual('');
        });
    });

    test('a forgotten value can no longer be resolved', async () => {
        await scope.run(async () => {
            scope.values.use('acme');
            scope.values.forget();

            expect(scope.values.resolve()).toBeUndefined();
            expect(() => scope.values.mustResolve()).toThrow(UnableToResolveValue);
        });
    });

    test('a matching value passes the mismatch check', async () => {
        await scope.run(async () => {
            scope.values.use('acme');

            expect(() => scope.values.preventMismatch('acme')).not.toThrow();
        });
    });

    test('a different value is reported as a mismatch', async () => {
        await scope.run(async () => {
            scope.values.use('acme');

            expect(() => scope.values.preventMismatch('other-tenant')).toThrow(
                ContextMismatchDetected.for('acme', 'other-tenant'),
            );
        });
    });

    test('a missing value is reported as unresolvable by the mismatch check', async () => {
        await scope.run(async () => {
            expect(() => scope.values.preventMismatch('acme')).toThrow(UnableToResolveValue);
        });
    });
});
