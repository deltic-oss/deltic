interface Factory<T = any> {
    (container: DependencyContainer): T;
}

type Cleanup<T> = (instance: T) => Promise<void> | void;

type ServiceDefinition<T = any> = {} & {
    factory: Factory<T>;
    lazy?: T extends object ? true : never;
} & (
        | {
              cache?: true;
              cleanup?: Cleanup<T>;
          }
        | {
              cache: false;
              cleanup?: never;
          }
    );

type InstanceDefinition<T = any> = {
    instance: T;
    cache?: true;
    cleanup?: Cleanup<T>;
};

type CreatedInstanceDefinition<T = any> = {
    factory: Factory<T>;
    cleanup?: Cleanup<T>;
};

/**
 * Represents a resolved service with its cleanup callback and direct dependencies.
 * Services take part in the cleanup graph when their destruction needs ordering: they
 * have a cleanup callback, they are constructed behind a proxy, or they are instances
 * created through `createInstance`.
 */
interface ResolvedService {
    key: string;
    cleanup?: Cleanup<any>;
    dependencies: Set<string>;
    instance: any;
}

declare const service: unique symbol;

export type ServiceKey<Service> = string & {
    [service]: Service;
};

export class DependencyContainer {
    // Maps rather than plain objects: an object registry walks Object.prototype, so a service
    // named `toString` or `valueOf` was reported as "already registered" on an empty container,
    // and resolving an unregistered name that Object.prototype carries returned a native function
    // instead of throwing.
    private readonly cache = new Map<string, any>();
    private readonly definitions = new Map<string, ServiceDefinition>();

    // Services that take part in the cleanup graph, see ResolvedService
    private readonly resolved = new Map<string, ResolvedService>();

    /**
     * Services that are transparent in the cleanup graph: they have nothing to clean up
     * themselves, so they collect the cleanup candidates resolved beneath them. When such a
     * service is served from cache, those candidates are attributed to the new consumer.
     */
    private readonly transparentDependencies = new Map<string, Set<string>>();

    // Stack to track current resolution chain
    private resolutionStack = new Set<string>();

    // Created instances have no key of their own, this makes their bookkeeping addressable
    private createdInstanceCount = 0;

    // The cleanup that is running, if any. Shutdown is commonly triggered from more than one place
    // at once (SIGTERM and SIGINT, a supervisor's deadline), and every trigger must wait for the
    // same shutdown rather than run each hook a second time.
    private cleanupInProgress: Promise<void> | undefined = undefined;

    register<Service, const Key extends string | ServiceKey<Service> = string>(
        key: Key,
        definition: ServiceDefinition<Service>,
    ): ServiceKey<Service> {
        if (this.definitions.has(key)) {
            throw new Error(`Dependency ${key} is already registered`);
        }

        if (definition.lazy) {
            const proxy = this.createProxyFor(
                key as unknown as ServiceKey<Service & object>,
                definition as ServiceDefinition<Service & object>,
            );
            definition.factory = () => proxy;
        }

        this.definitions.set(key, definition);

        return key as unknown as ServiceKey<Service>;
    }

    /**
     * Shuts down every service that takes part in the cleanup graph. A call made while a cleanup
     * is running joins that cleanup instead of starting another one, so every hook runs once.
     */
    cleanup(): Promise<void> {
        this.cleanupInProgress ??= this.runCleanup().finally(() => {
            this.cleanupInProgress = undefined;
        });

        return this.cleanupInProgress;
    }

    private async runCleanup(): Promise<void> {
        const levels = this.computeShutdownLevels();

        for (const level of levels) {
            await Promise.all(
                level.map(key => {
                    const resolved = this.resolved.get(key);

                    return resolved?.instance === undefined ? Promise.resolve() : resolved.cleanup?.(resolved.instance);
                }),
            );
        }

        this.cache.clear();
        this.resolved.clear();
        this.transparentDependencies.clear();
    }

    /**
     * Computes cleanup levels using reverse topological sort.
     * Services in the same level have no dependencies between them and can shut down concurrently.
     * Levels are ordered from leaves (nothing depends on them) to roots (depends on nothing).
     */
    private computeShutdownLevels(): string[][] {
        const dependencies = new Map<string, Set<string>>();

        for (const [key, service] of this.resolved.entries()) {
            for (const dependency of service.dependencies) {
                if (!dependencies.has(dependency)) {
                    dependencies.set(dependency, new Set());
                }
                dependencies.get(dependency)!.add(key);
            }
        }

        const levels: string[][] = [];
        const processed = new Set<string>();
        const resolvedKeys = Array.from(this.resolved.keys());

        while (processed.size < resolvedKeys.length) {
            // Find services whose dependents have all been processed
            const currentLevel = resolvedKeys.filter(key => {
                if (processed.has(key)) {
                    return false;
                }

                const serviceDependents = dependencies.get(key) ?? new Set();

                return processed.isSupersetOf(serviceDependents);
            });

            if (currentLevel.length === 0) {
                break;
            }

            levels.push(currentLevel);
            currentLevel.forEach(key => processed.add(key));
        }

        if (processed.size < resolvedKeys.length) {
            const missing = new Set(resolvedKeys).difference(processed);

            throw new Error(
                `Circular dependency detected in cleanup routine, could not shut down: ${[...missing].join(', ')}.`,
            );
        }

        return levels;
    }

    /**
     * Records a dependency relationship between the nearest ancestor that is a cleanup
     * candidate. This may either be a lazy service, a service with a cleanup callback, or a
     * created instance. Ancestors in between are transparent in the cleanup graph, they take
     * note of what was resolved beneath them so a later cache hit can attribute the same
     * dependencies to whoever consumes them next.
     */
    private recordDependencies(dependencies: Iterable<string>): void {
        const resolutionStack = Array.from(this.resolutionStack).toReversed();

        // for loops are more performant than findLast
        for (const ancestor of resolutionStack) {
            const ancestorService = this.resolved.get(ancestor);

            if (ancestorService) {
                for (const dependency of dependencies) {
                    // A service that resolves itself, lazily or through a cycle, is not its own
                    // dependency: a self-edge carries no order, and would make the graph unorderable
                    if (dependency !== ancestor) {
                        ancestorService.dependencies.add(dependency);
                    }
                }

                return; // Only record for the nearest parent
            }

            const transparentAncestor = this.transparentDependencies.get(ancestor);

            if (transparentAncestor) {
                for (const dependency of dependencies) {
                    transparentAncestor.add(dependency);
                }
            }
        }
    }

    /**
     * Services served from cache did not resolve their dependencies again, so the dependencies
     * discovered during their construction are attributed to the current consumer.
     */
    private recordCachedDependencies(key: string): void {
        if (this.resolved.has(key)) {
            this.recordDependencies([key]);

            return;
        }

        const transparentDependencies = this.transparentDependencies.get(key);

        if (transparentDependencies !== undefined && transparentDependencies.size > 0) {
            this.recordDependencies(transparentDependencies);
        }
    }

    /**
     * Adds a service to the cleanup graph. A service that was transparent until now inherits
     * the dependencies it collected while it was.
     */
    private trackService(key: string, cleanup?: Cleanup<any>): ResolvedService {
        const resolved: ResolvedService = {
            key,
            cleanup,
            dependencies: this.transparentDependencies.get(key) ?? new Set(),
            instance: undefined,
        };

        this.transparentDependencies.delete(key);
        this.resolved.set(key, resolved);

        return resolved;
    }

    registerInstance<Service extends object>(
        key: string | ServiceKey<Service>,
        definition: InstanceDefinition<Service>,
    ): ServiceKey<Service> {
        if (this.definitions.has(key)) {
            throw new Error(`Dependency ${key} is already registered`);
        }

        const {cleanup, instance} = definition;
        this.cache.set(key, instance);
        this.definitions.set(key, {
            ...definition,
            factory: () => instance,
        });

        if (cleanup) {
            this.trackService(key, cleanup).instance = instance;
        }

        return key as unknown as ServiceKey<Service>;
    }

    /**
     * Creates an instance outside of the service registry. The factory resolves whatever it
     * needs from the container, which makes the instance part of the cleanup graph: it is
     * cleaned up before the services it depends on, and after whatever created it.
     */
    createInstance<Instance>(definition: CreatedInstanceDefinition<Instance>): Instance {
        const {factory, cleanup} = definition;
        // Created instances are never registered, this key only addresses the cleanup graph
        const key = `@created-instance#${++this.createdInstanceCount}`;

        // Track BEFORE executing the factory so that dependencies can record this
        // instance as their parent
        const resolved = this.trackService(key, cleanup);
        this.recordDependencies([key]);

        this.resolutionStack.add(key);
        const instance = factory(this);
        this.resolutionStack.delete(key);

        resolved.instance = instance;

        return instance;
    }

    private createProxyFor<Service extends object>(
        key: ServiceKey<Service>,
        definition: ServiceDefinition<Service>,
    ): Service {
        const {factory, cache = true, cleanup} = definition;
        const resolveInstance = () => {
            // `has` rather than truthiness, so an intentionally falsy instance is cached too.
            if (this.cache.has(key)) {
                return this.cache.get(key);
            }

            // Proxied services always take part in the cleanup graph, see resolveLazy. The
            // service is tracked again when the proxy is first used after a cleanup.
            const resolved = this.resolved.get(key) ?? this.trackService(key, cleanup);

            this.resolutionStack.add(key);
            const instance = factory(this);
            this.resolutionStack.delete(key);

            resolved.instance = instance;

            if (cache) {
                this.cache.set(key, instance);
            }

            return instance;
        };

        return this.createProxy(resolveInstance);
    }

    private createProxy<Service extends object>(createInstance: () => Service): Service {
        let instance: Service | undefined = undefined;
        const handlers: ProxyHandler<Service> = {};

        for (const method of reflectMethods) {
            handlers[method] = (...args: any[]) => {
                args[0] = instance ??= createInstance();
                return (Reflect[method] as any)(...args);
            };
        }

        return new Proxy<Service>({} as Service, handlers);
    }

    resolveLazy<Service extends object>(key: ServiceKey<Service>): Service {
        const definition = this.definitions.get(key);

        if (!definition) {
            throw new Error(`No definition found for key "${key}".`);
        }

        // A proxy postpones construction beyond the current resolution, which is why proxied
        // services always take part in the cleanup graph: by the time their factory runs, the
        // resolution stack no longer holds the ancestors that led here.
        if (!this.resolved.has(key)) {
            this.trackService(key, definition.cleanup);
        }

        this.recordDependencies([key]);

        return this.createProxyFor(key, definition);
    }

    resolve<const Service extends object>(key: ServiceKey<Service>): Service {
        if (this.resolutionStack.has(key)) {
            return this.resolveLazy<Service>(key);
        }

        // `has` rather than truthiness, so an intentionally falsy instance is cached too.
        if (this.cache.has(key)) {
            this.recordCachedDependencies(key);

            return this.cache.get(key);
        }

        const definition = this.definitions.get(key) as ServiceDefinition<Service> | undefined;

        if (definition === undefined) {
            throw new Error(`No definition found for key "${key}".`);
        }

        const {factory, cleanup, cache = true, lazy = false} = definition;
        let resolved: ResolvedService | undefined = undefined;

        // Register cleanup callback BEFORE executing factory so that child
        // dependencies can record this service as their parent
        if (cleanup || lazy) {
            resolved = this.trackService(key, cleanup);

            this.recordDependencies([key]);
        } else if (cache) {
            // Nothing to clean up, but the instance is shared from here on, so it collects the
            // dependencies that later consumers cannot discover for themselves
            this.transparentDependencies.set(key, new Set());
        }

        this.resolutionStack.add(key);
        const instance = factory(this);
        this.resolutionStack.delete(key);

        if (cache && !lazy) {
            if (resolved) {
                resolved.instance = instance;
            }

            this.cache.set(key, instance);
        }

        return instance;
    }
}

/**
 * Create service keys without registering a service. Only use this to work around the
 * intentional limitation of only receiving a token when a service is registered. This
 * is an escape-hatch, proceed with caution.
 */
export function forgeServiceKey<Service>(key: string): ServiceKey<Service> {
    return key as unknown as ServiceKey<Service>;
}

export const container = new DependencyContainer();

/**
 * @internal
 */
export const reflectMethods = [
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
