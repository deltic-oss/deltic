export type ServiceStructure<D> = {
    [K in keyof D]: {payload: any; response: any};
};

type InputForServicePerType<Service extends ServiceStructure<Service>> = {
    [Type in keyof Service]: {
        readonly type: Type;
        readonly payload: Service[Type]['payload'];
    };
}

export type AnyInputForService<Service extends ServiceStructure<Service>> = InputForServicePerType<Service>[keyof Service];
export type InputForServiceOfType<Service extends ServiceStructure<Service>, Type extends keyof Service> = InputForServicePerType<Service>[Type];

export interface ServiceMiddleware<Service extends ServiceStructure<Service>> {
    <T extends keyof Service>(input: InputForServiceOfType<Service, T>, next: NextFunction<Service>): Promise<Service[T]['response']>;
}

export interface NextFunction<Service extends ServiceStructure<Service>> {
    <T extends keyof Service>(input: InputForServiceOfType<Service, T>): Promise<Service[T]['response']>;
}

export type ServiceHandlers<Service extends ServiceStructure<Service>> = {
    readonly [T in keyof Service]: (input: Service[T]['payload']) => Promise<Service[T]['response']>;
};

export class InputNotSupported extends Error {}

/**
 * The handler registered for an input type, or `InputNotSupported`. Only own properties count, so an
 * input type such as `toString` or `constructor` cannot resolve to a member of `Object.prototype`.
 *
 * @internal
 */
export function resolveHandler<Handlers extends object, Type extends keyof Handlers>(
    handlers: Handlers,
    type: Type,
): Handlers[Type] {
    const handler = Object.hasOwn(handlers, type) ? handlers[type] : undefined;

    if (typeof handler !== 'function') {
        throw new InputNotSupported(`Unable to handle input of type: ${String(type)}`);
    }

    return handler;
}

export interface Service<Structure extends ServiceStructure<Structure>> {
    handle<T extends keyof Structure>(input: InputForServiceOfType<Structure, T>): Promise<Structure[T]['response']> | Structure[T]['response'];
}

interface ChainHandler<Service extends ServiceStructure<Service>> {
    <T extends keyof Service>(
        input: InputForServiceOfType<Service, T>,
    ): Promise<Service[T]['response']> | Service[T]['response'];
}

export class ServiceDispatcher<S extends ServiceStructure<S>> implements Service<S> {
    private readonly chain: ChainHandler<S>;
    constructor(
        private readonly handlers: ServiceHandlers<S>,
        private readonly middlewares: ServiceMiddleware<S>[] = [],
    ) {
        let next: ChainHandler<S> = async (input) => await this.process(input);

        for (let index = this.middlewares.length - 1; index >= 0; index -= 1) {
            const m = this.middlewares[index];
            const n = next;
            next = async (input) => await m(input, n);
        }

        this.chain = next;
    }

    public handle<T extends keyof S>(input: InputForServiceOfType<S, T>): Promise<S[T]['response']> {
        return this.chain(input);
    }

    private async process<T extends keyof S>(
        input: InputForServiceOfType<S, T>,
    ): Promise<S[T]['response']> {
        const handler = resolveHandler(this.handlers, input.type);

        return await handler(input.payload);
    }
}
