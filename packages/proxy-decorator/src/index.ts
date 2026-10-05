const reflectMethods = [
    'apply',
    'construct',
    'defineProperty',
    'deleteProperty',
    'get',
    'getOwnPropertyDescriptor',
    'getPrototypeOf',
    'has',
    'isExtensible',
    'ownKeys',
    'preventExtensions',
    'set',
    'setPrototypeOf',
] as const;

type ReflectionMethods = (typeof reflectMethods)[number];

export type DecoratorsForInstance<Instance extends object> = {
    [K in keyof Instance]?: K extends ReflectionMethods
        ? never
        : Instance[K] extends (...args: infer Args) => infer Result
          ? (inner: Instance[K], ...args: Args) => Result
          : never;
};

type Method = (...args: unknown[]) => unknown;
type Decorator = (inner: Method, ...args: unknown[]) => unknown;

export function decorateInstance<Instance extends object>(
    instance: Instance,
    decorators: DecoratorsForInstance<Instance>,
): Instance {
    return new Proxy<Instance>(instance, {
        get(target, property) {
            if (Object.hasOwn(decorators, property)) {
                const decorator = (decorators as Record<PropertyKey, unknown>)[property] as Decorator;
                const inner = (Reflect.get(target, property) as Method).bind(target);

                return (...args: unknown[]) => decorator(inner, ...args);
            }

            // Methods are bound to the instance, so its own calls to a decorated method stay undecorated
            const value: unknown = Reflect.get(target, property);

            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
