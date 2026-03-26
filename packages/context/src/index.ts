import {StandardError} from '@deltic/error-standard';

export type ContextValue = null | object | undefined | string | number | boolean | ContextValue[] | ContextObject;

export type ContextObject = {
    [index: string | number]: ContextValue;
};

export type ContextData<C> = {
    [K in keyof C]: C[K];
};

/**
 * This interface is intended to be compatible with AsyncLocalStorage so that context
 * can be scoped to HTTP requests and the processing of messages.
 */
export interface ContextStore<C extends ContextData<C>> {
    getStore(): Partial<C> | undefined;

    run<R>(store: Partial<C>, callback: () => Promise<R>): Promise<R>;
}

export class ContextStoreUsingMemory<C extends ContextData<C>> implements ContextStore<C> {
    constructor(private context: Partial<C> = {}) {
    }

    getStore(): Partial<C> | undefined {
        return this.context;
    }

    async run<R>(store: Partial<C>, callback: () => Promise<R>): Promise<R> {
        const previous = this.context;
        this.context = store;

        try {
            return await callback();
        } finally {
            this.context = previous;
        }
    }
}

/**
 * Function type for creating context values by merging inherited and provided values.
 */
export type ContextValueCreator<C> = (inherited: Partial<C>, provided: Partial<C>) => Partial<C>;

/**
 * Default context value creator that merges inherited values with provided values.
 */
function defaultContextValueCreator<C>(inherited: Partial<C>, provided: Partial<C>): Partial<C> {
    return {...inherited, ...provided};
}

export interface ContextRunner<C extends ContextData<C>> {
    run<R>(fn: () => Promise<R>, context?: Partial<C>): Promise<R>;
}

export interface ContextWriter<C extends ContextData<C>> {
    attach(context: Partial<C>): void;
}

export interface ContextReader<C extends ContextData<C>> {
    context(): Partial<C>;

    get<K extends keyof C>(key: K): C[K] | undefined;
}

export interface ContextReadWriter<C extends ContextData<C>> extends ContextReader<C>, ContextWriter<C> {
}

export interface ContextOperator<C extends ContextData<C>> extends ContextRunner<C>, ContextReadWriter<C> {
}

export class Context<C extends ContextData<C>> implements ContextOperator<C> {
    constructor(
        private readonly storage: ContextStore<Partial<C>>,
        private readonly createContextValue: ContextValueCreator<C> = defaultContextValueCreator,
    ) {
    }

    async run<R>(fn: () => Promise<R>, context: Partial<C> = {}): Promise<R> {
        const inherited = this.storage.getStore() ?? {};
        const merged = this.createContextValue(inherited, context);
        return this.storage.run(merged, fn);
    }

    attach(context: Partial<C>): void {
        const store = this.storage.getStore();

        if (store === undefined) {
            throw new Error('No async context available, missing middleware or consumer decorator?');
        }

        for (const [key, value] of Object.entries(context)) {
            (store as any)[key] = value;
        }
    }

    get<K extends keyof C>(key: K): C[K] | undefined {
        return this.storage.getStore()?.[key];
    }

    context(): Partial<C> {
        return this.storage.getStore() ?? {};
    }
}

export interface ValueReader<Value> {
    resolve(): Value | undefined;

    mustResolve(): Value;

    preventMismatch(value: Value): void;
}

export interface ValueReadWriter<Value> extends ValueReader<Value> {
    use(context?: Value): void;

    forget(): void;
}

export class ValueReadWriterUsingMemory<Value extends string | number> implements ValueReadWriter<Value> {
    constructor(private value?: Value) {
    }

    resolve(): Value | undefined {
        return this.value;
    }

    preventMismatch(value: Value) {
        preventMismatch(this.mustResolve(), value);
    }

    mustResolve(): Value {
        if (this.value === undefined) {
            throw new UnableToResolveValue();
        }

        return this.value;
    }

    use(context?: Value): void {
        this.value = context;
    }

    forget(): void {
        this.use(undefined);
    }
}

type KeyValueToObject<Key extends string, Value extends string | number> = {
    [K in Key]: Value;
};

export class ValueReadWriterUsingContext<
    const Key extends string,
    Value extends string | number,
> implements ValueReadWriter<Value> {
    constructor(
        private readonly context: Context<KeyValueToObject<Key, Value>>,
        private readonly key: Key,
    ) {
    }

    forget(): void {
        this.use(undefined);
    }

    resolve(): Value | undefined {
        return this.context.get(this.key);
    }

    use(value: Value | undefined): void {
        this.context.attach({
            [this.key]: value,
        } as KeyValueToObject<Key, Value>);
    }

    preventMismatch(value: Value) {
        preventMismatch(this.mustResolve(), value);
    }

    mustResolve(): Value {
        const resolved = this.resolve();

        if (resolved === undefined) {
            throw new UnableToResolveValue();
        }

        return resolved;
    }
}

export class UnableToResolveValue extends StandardError {
    constructor() {
        super('Value is not found. Forgot to set it?', 'context.unable_to_resolve_value');
    }
}

export function preventMismatch<Value extends string | number>(
    expected: Value,
    actual: Value,
): void {
    if (actual !== expected) {
        throw ContextMismatchDetected.for(expected, actual);
    }
}

export class ContextMismatchDetected extends StandardError {
    static for<Value extends string | number>(
        expected: Value,
        actual: Value,
    ) {
        return new ContextMismatchDetected(
            `Context mismatch operation detected. Expected ${String(expected)} detected ${String(actual)}`,
            'context.mismatch_detected',
            {expected, actual},
        );
    }
}

// ============================================================================
// Composite Context
// ============================================================================

/**
 * Represents a single slot in a composite context with a typed key and optional default value.
 */
export interface ContextSlot<Key extends string, Value> {
    readonly key: Key;

    defaultValue?(): Value;

    readonly inherited: boolean;
}

/**
 * Creates a context slot definition with a typed key and optional lazy default value.
 *
 * @example
 * const tenantSlot = defineContextSlot<'tenant_id', string>({key: 'tenant_id'});
 * const userSlot = defineContextSlot({key: 'user_id', defaultValue: () => 'anonymous'});
 * const txSlot = defineContextSlot({key: 'tx', defaultValue: () => createTx(), inherited: false});
 */
export function defineContextSlot<const Key extends string, Value>(options: {
    key: Key;
    defaultValue?(): Value;
    inherited?: boolean;
}): ContextSlot<Key, Value> {
    return {key: options.key, defaultValue: options.defaultValue, inherited: options.inherited ?? true};
}

/**
 * Derives the context data structure from an array of context slots,
 * mapping each slot's key to its value type.
 */
export type ContextDataFromSlots<Slots extends readonly ContextSlot<string, unknown>[]> = {
    [S in Slots[number] as S['key']]: S extends ContextSlot<string, infer V> ? V : never;
};

/**
 * Composes multiple context slots into a single Context with defaults support.
 *
 * The slots define the shape of the context and optional default values. After composition,
 * the result is a standard Context that can be used like any other Context.
 *
 * @example
 * const tenantSlot = defineContextSlot<'tenant_id', string>({key: 'tenant_id'});
 * const userSlot = defineContextSlot({key: 'user_id', defaultValue: () => 'anonymous'});
 *
 * const requestContext = composeContextSlots(
 *     [tenantSlot, userSlot],
 *     new AsyncLocalStorage(),
 * );
 *
 * await requestContext.run(async () => {
 *     requestContext.get('tenant_id'); // 'acme'
 *     requestContext.get('user_id');   // 'anonymous' (default)
 * }, {tenant_id: 'acme'});
 */
export function composeContextSlots<
    const Slots extends readonly ContextSlot<string, unknown>[],
>(
    slots: Slots,
    store: ContextStore<ContextDataFromSlots<Slots>> = new ContextStoreUsingMemory<ContextDataFromSlots<Slots>>(),
): Context<ContextDataFromSlots<Slots>> {
    return new Context(store, createContextValueCreator(slots));
}

function createContextValueCreator<
    const Slots extends readonly ContextSlot<string, unknown>[],
>(
    slots: Slots,
): ContextValueCreator<ContextDataFromSlots<Slots>> {
    return (
        inherited: Partial<ContextDataFromSlots<Slots>>,
        provided: Partial<ContextDataFromSlots<Slots>>,
    ): Partial<ContextDataFromSlots<Slots>> => {
        const result: Record<string, unknown> = {};

        for (const slot of slots) {
            const key = slot.key;

            if (key in provided) {
                result[key] = (provided as Record<string, unknown>)[key];
            } else if (slot.inherited && key in inherited) {
                result[key] = (inherited as Record<string, unknown>)[key];
            } else if (slot.defaultValue !== undefined) {
                result[key] = slot.defaultValue();
            }
        }

        return result as Partial<ContextDataFromSlots<Slots>>;
    };
}

export function composeContextSlotsForTesting<
    const Slots extends readonly ContextSlot<string, unknown>[],
>(
    slots: Slots,
): Context<ContextDataFromSlots<Slots>> {
    const creator = createContextValueCreator(slots);
    const store = new ContextStoreUsingMemory(creator({}, {}));

    return new Context(store, creator);
}
