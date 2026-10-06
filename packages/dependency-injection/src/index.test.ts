import {
    CleanupFailed,
    DependencyContainer,
    reflectMethods,
    container as exportedContainer,
    forgeServiceKey,
    type ServiceKey,
} from './index.js';
import {isProxy} from 'node:util/types';
import {setTimeout as wait} from 'node:timers/promises';

describe('@deltic/dependency-injection', () => {
    let container: DependencyContainer;

    beforeEach(() => (container = new DependencyContainer()));

    test('the exported container is a Dependency', () => {
        expect(exportedContainer).toBeInstanceOf(DependencyContainer);
    });

    describe('lazy dependencies', () => {
        let segments: string[];
        let somethingKey: ServiceKey<Dependency>;

        beforeEach(() => {
            segments = [];
            somethingKey = container.register('something', {
                lazy: true,
                factory: () => {
                    segments.push('during');
                    return new Dependency('something');
                },
            });
        });

        test('can be resolved', () => {
            segments.push('before');
            const something = container.resolve(somethingKey);
            segments.push('resolved');
            expect(something.name).toEqual('something');
            segments.push('after');
            expect(segments.join('-')).toEqual('before-resolved-during-after');
        });

        test('the next resolve is the actual instance', () => {
            let something = container.resolve(somethingKey);
            expect(something).toBeInstanceOf(Dependency);
            expect(isProxy(something)).toEqual(true);
            something = container.resolve<Dependency>(somethingKey);
            expect(something).toBeInstanceOf(Dependency);
            expect(isProxy(something)).toEqual(false);
        });
    });

    /**
     * Cleanups are a tad primitive right now, it sequentially executes the cleanup callbacks in
     * reverse order of resolving. This is to ensure each instance can shut down whilst their
     * dependencies have not yet shut down, ensuring their cleanup has functional dependencies.
     *
     * At a later point in time, a more sophisticated cleanup routine may be used.
     */
    describe('cleanups - one service depending on another', () => {
        let segments: string[];

        interface Inner {
            lol: string;
        }
        interface Outer {
            dependency: Inner;
        }
        let innerKey: ServiceKey<Inner>;
        let outerKey: ServiceKey<Outer>;

        beforeEach(() => {
            segments = [];
            innerKey = container.register('inner', {
                factory: () => ({
                    lol: 'what',
                }),
                cleanup: async () => {
                    segments.push('inner');
                },
            });

            outerKey = container.register('outer', {
                factory: container => ({
                    dependency: container.resolve(innerKey),
                }),
                cleanup: async () => {
                    segments.push('outer');
                },
            });
        });

        test('cleanups are not triggered when the instances are not resolved', async () => {
            await container.cleanup();

            expect(segments).toHaveLength(0);
        });

        test('when one service is resolved, one cleanup happens', async () => {
            container.resolve(innerKey);

            await container.cleanup();

            expect(segments).toHaveLength(1);
            expect(segments[0]).toEqual(innerKey);
        });

        test('when two service is resolved, cleanup happens in order', async () => {
            container.resolve(outerKey);

            await container.cleanup();

            expect(segments).toHaveLength(2);
            expect(segments[0]).toEqual('outer');
            expect(segments[1]).toEqual('inner');
        });

        test('when two service is explicitly resolved, cleanup happens in order', async () => {
            container.resolve(outerKey);
            container.resolve(innerKey);

            await container.cleanup();

            expect(segments).toHaveLength(2);
            expect(segments[0]).toEqual(outerKey);
            expect(segments[1]).toEqual(innerKey);
        });

        test('when two service is explicitly resolved in reversed, cleanup still happens in order', async () => {
            container.resolve(innerKey);
            container.resolve(outerKey);

            await container.cleanup();

            expect(segments).toHaveLength(2);
            expect(segments[0]).toEqual('outer');
            expect(segments[1]).toEqual('inner');
        });
    });

    describe('complex cleanups are concurrent', () => {
        const segments: string[] = [];
        let innerKey: ServiceKey<Dependency>;
        let middleNormalKey: ServiceKey<Middle>;
        let middleLazyKey: ServiceKey<Middle>;
        let outerNormalKey: ServiceKey<Outer>;
        let outerLazyKey: ServiceKey<Outer>;

        beforeEach(() => {
            segments.length = 0;

            innerKey = container.register('inner', {
                factory: () => new Dependency('inner'),
                cleanup: async instance => {
                    segments.push(instance.name);
                    await wait(2);
                    segments.push(instance.name);
                },
            });

            middleNormalKey = container.register('middle-normal', {
                factory: c => {
                    return new Middle('middle-normal', c.resolve<Dependency>(innerKey));
                },
            });

            middleLazyKey = container.register<Middle>('middle-lazy', {
                lazy: true,
                factory: c => {
                    return new Middle('middle-lazy', c.resolve<Dependency>(innerKey));
                },
            });

            outerNormalKey = container.register<Outer>('outer-normal', {
                factory: c => {
                    const middle = c.resolve<Middle>(middleNormalKey);
                    return new Outer('outer-normal', middle);
                },
                cleanup: async instance => {
                    segments.push(instance.name);
                    await wait(2);
                    segments.push(instance.name);
                },
            });

            outerLazyKey = container.register<Outer>('outer-lazy', {
                factory: c => {
                    const middle = c.resolve<Middle>(middleLazyKey);
                    return new Outer('outer-lazy', middle);
                },
                lazy: true,
                cleanup: async instance => {
                    segments.push(instance.name);
                    await wait(2);
                    segments.push(instance.name);
                },
            });
        });

        test('resolving outer normal', async () => {
            const outerNormal = container.resolve<Outer>(outerNormalKey);

            expect(outerNormal.name).toEqual('outer-normal');
            expect(outerNormal.middle.name).toEqual('middle-normal');
            expect(outerNormal.middle.inner.name).toEqual('inner');

            await container.cleanup();

            expect(segments).toEqual(['outer-normal', 'outer-normal', 'inner', 'inner']);
        });

        test('resolving outer lazy', async () => {
            const outerLazy = container.resolve<Outer>(outerLazyKey);

            expect(outerLazy.name).toEqual('outer-lazy');
            expect(outerLazy.middle.name).toEqual('middle-lazy');
            expect(outerLazy.middle.inner.name).toEqual('inner');

            await container.cleanup();

            expect(segments).toEqual(['outer-lazy', 'outer-lazy', 'inner', 'inner']);
        });

        test('resolving and use both (and trigger lazy proxy)', async () => {
            container.resolve<Outer>(outerNormalKey);
            const lazy = container.resolve<Outer>(outerLazyKey);

            expect(lazy.name).toEqual('outer-lazy');

            await container.cleanup();

            expect(segments).toEqual(['outer-normal', 'outer-lazy', 'outer-normal', 'outer-lazy', 'inner', 'inner']);
        });

        test('cleanups are no invoked for lazy services that are not used', async () => {
            container.resolve<Outer>(outerLazyKey);

            await container.cleanup();

            expect(segments).toEqual([]);
        });
    });

    describe('cleanups of services without a cleanup of their own', () => {
        let segments: string[];
        let poolKey: ServiceKey<Dependency>;
        let repositoryKey: ServiceKey<Middle>;

        const trackCleanup = async (instance: {name: string}) => {
            segments.push(instance.name);
            await wait(2);
            segments.push(instance.name);
        };

        beforeEach(() => {
            segments = [];
            poolKey = container.register('pool', {
                factory: () => new Dependency('pool'),
                cleanup: trackCleanup,
            });
            repositoryKey = container.register('repository', {
                factory: c => new Middle('repository', c.resolve(poolKey)),
            });
        });

        test('a service consuming a cached one inherits its dependencies', async () => {
            container.resolve(repositoryKey);

            const consumerKey = container.register('consumer', {
                factory: c => new Outer('consumer', c.resolve(repositoryKey)),
                cleanup: trackCleanup,
            });

            container.resolve(consumerKey);

            await container.cleanup();

            expect(segments).toEqual(['consumer', 'consumer', 'pool', 'pool']);
        });

        test('dependencies are inherited through a chain of cached services', async () => {
            const middlemanKey = container.register('middleman', {
                factory: c => ({name: 'middleman', repository: c.resolve(repositoryKey)}),
            });

            container.resolve(middlemanKey);

            const consumerKey = container.register('consumer', {
                factory: c => ({name: 'consumer', middleman: c.resolve(middlemanKey)}),
                cleanup: trackCleanup,
            });

            container.resolve(consumerKey);

            await container.cleanup();

            expect(segments).toEqual(['consumer', 'consumer', 'pool', 'pool']);
        });

        test('a service resolved as a proxy owns the dependencies it resolves', async () => {
            const consumerKey = container.register('consumer', {
                factory: c => new Outer('consumer', c.resolve(repositoryKey)),
                cleanup: trackCleanup,
            });

            const consumer = container.resolveLazy(consumerKey);

            expect(consumer.name).toEqual('consumer');

            await container.cleanup();

            expect(segments).toEqual(['consumer', 'consumer', 'pool', 'pool']);
        });

        test('a proxy used for the first time after a cleanup is cleaned up again', async () => {
            const consumerKey = container.register('consumer', {
                factory: c => new Outer('consumer', c.resolve(repositoryKey)),
                cleanup: trackCleanup,
            });

            const consumer = container.resolveLazy(consumerKey);

            await container.cleanup();

            expect(segments).toEqual([]);
            expect(consumer.name).toEqual('consumer');

            await container.cleanup();

            expect(segments).toEqual(['consumer', 'consumer', 'pool', 'pool']);
        });
    });

    describe('created instances', () => {
        let segments: string[];
        let poolKey: ServiceKey<Dependency>;

        const trackCleanup = async (instance: {name: string}) => {
            segments.push(instance.name);
            await wait(2);
            segments.push(instance.name);
        };

        beforeEach(() => {
            segments = [];
            poolKey = container.register('pool', {
                factory: () => new Dependency('pool'),
                cleanup: trackCleanup,
            });
        });

        test('a created instance inherits the dependencies of the cached services it consumes', async () => {
            const repositoryKey = container.register('repository', {
                factory: c => new Middle('repository', c.resolve(poolKey)),
            });

            container.resolve(repositoryKey);

            container.createInstance({
                factory: c => new Outer('created', c.resolve(repositoryKey)),
                cleanup: trackCleanup,
            });

            await container.cleanup();

            expect(segments).toEqual(['created', 'created', 'pool', 'pool']);
        });

        test('a created instance resolves dependencies and is cleaned up before them', async () => {
            const created = container.createInstance({
                factory: c => new Middle('created', c.resolve(poolKey)),
                cleanup: trackCleanup,
            });

            expect(created.name).toEqual('created');
            expect(created.inner).toBe(container.resolve(poolKey));

            await container.cleanup();

            expect(segments).toEqual(['created', 'created', 'pool', 'pool']);
        });

        test('created instances sharing a dependency are cleaned up concurrently, before it', async () => {
            for (const name of ['first', 'second']) {
                container.createInstance({
                    factory: c => new Middle(name, c.resolve(poolKey)),
                    cleanup: trackCleanup,
                });
            }

            await container.cleanup();

            expect(segments).toEqual(['first', 'second', 'first', 'second', 'pool', 'pool']);
        });

        test('an instance created while resolving a service is cleaned up after that service', async () => {
            const outerKey = container.register('outer', {
                factory: c =>
                    new Outer(
                        'outer',
                        c.createInstance({
                            factory: c => new Middle('created', c.resolve(poolKey)),
                            cleanup: trackCleanup,
                        }),
                    ),
                cleanup: trackCleanup,
            });

            container.resolve(outerKey);

            await container.cleanup();

            expect(segments).toEqual(['outer', 'outer', 'created', 'created', 'pool', 'pool']);
        });

        test('nested created instances are cleaned up from the outside in', async () => {
            container.createInstance({
                factory: c =>
                    new Outer(
                        'outer-created',
                        c.createInstance({
                            factory: c => new Middle('inner-created', c.resolve(poolKey)),
                            cleanup: trackCleanup,
                        }),
                    ),
                cleanup: trackCleanup,
            });

            await container.cleanup();

            expect(segments).toEqual([
                'outer-created',
                'outer-created',
                'inner-created',
                'inner-created',
                'pool',
                'pool',
            ]);
        });

        test('a created instance without a cleanup still orders the cleanup of its dependencies', async () => {
            const outerKey = container.register('outer', {
                factory: c => new Middle('outer', c.resolve(poolKey)),
                cleanup: trackCleanup,
            });

            const created = container.createInstance({
                factory: c => new Outer('created', c.resolve(outerKey)),
            });

            expect(created.middle.name).toEqual('outer');

            await container.cleanup();

            expect(segments).toEqual(['outer', 'outer', 'pool', 'pool']);
        });

        test('created instances are only cleaned up once', async () => {
            container.createInstance({
                factory: () => new Dependency('created'),
                cleanup: trackCleanup,
            });

            await container.cleanup();
            await container.cleanup();

            expect(segments).toEqual(['created', 'created']);
        });
    });

    test('ensure all proxy calls are handled', () => {
        const allReflectMethods = {
            apply: true,
            construct: true,
            defineProperty: true,
            deleteProperty: true,
            get: true,
            getOwnPropertyDescriptor: true,
            getPrototypeOf: true,
            has: true,
            isExtensible: true,
            ownKeys: true,
            preventExtensions: true,
            set: true,
            setPrototypeOf: true,
        } as const satisfies {
            [K in keyof Required<ProxyHandler<any>>]: true;
        };

        const expected = Object.keys(allReflectMethods).toSorted();

        expect(reflectMethods.toSorted()).toEqual(expected);
    });

    test('being able to lazily resolve a dependency', () => {
        const someKey: ServiceKey<{index: number}> = container.register('some', {
            factory: () => {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const {SomeDependency} = require('./index.stub.js');

                return new SomeDependency(42);
            },
        });

        const dep = container.resolve(someKey);
        expect(dep.index).toEqual(42);
    });

    test('resolve a non-lazy dependency as a proxy', () => {
        const token = container.register('something', {
            factory: () => new Dependency('what'),
        });

        const proxy = container.resolveLazy(token);

        expect(isProxy(proxy)).toEqual(true);
    });

    test('resolve a lazy dependency as a proxy', () => {
        const token = container.register('something', {
            factory: () => new Dependency('what'),
            lazy: true,
        });

        const proxy = container.resolveLazy(token);

        expect(isProxy(proxy)).toEqual(true);
    });

    test('shutting down registered instances', async () => {
        const instance = new Dependency('name');
        let hascleanup = false;

        container.registerInstance('something', {
            instance,
            cleanup: () => {
                hascleanup = true;
            },
        });

        await container.cleanup();

        expect(hascleanup).toEqual(true);
    });

    test('cleanups with circular dependencies cause errors', async () => {
        const segments: string[] = [];

        class Something {
            constructor(
                public readonly name: string,
                private readonly collection: SomeCollection,
            ) {}

            allNames(): string[] {
                return this.collection.allNames();
            }
        }

        class SomeCollection {
            constructor(
                public readonly name: string,
                private readonly members: Something[],
            ) {}

            allNames(): string[] {
                return this.members.map(m => m.name);
            }
        }

        // eslint-disable-next-line prefer-const
        let collectionToken: ServiceKey<SomeCollection>;

        const somethingToken = container.register('something', {
            factory: c => {
                return new Something('main', c.resolve<SomeCollection>(collectionToken));
            },
            cleanup: async instance => {
                segments.push(instance.name);
                await wait(2);
                segments.push(instance.name);
            },
        });

        collectionToken = container.register('collection', {
            factory: c => {
                return new SomeCollection('collection', [c.resolve<Something>(somethingToken)]);
            },
            cleanup: async instance => {
                segments.push(instance.name);
                await wait(2);
                segments.push(instance.name);
            },
        });

        const something = container.resolve<Something>(somethingToken);

        expect(something.allNames()).toEqual(['main']);

        await expect(container.cleanup()).rejects.toThrow(
            new Error('Circular dependency detected in cleanup routine, could not shut down: something, collection.'),
        );

        expect(segments).toHaveLength(0);
    });

    test('resolving a dependency using a forged key', () => {
        class SomeThing {
            constructor(public readonly name: string) {}
        }

        const key = forgeServiceKey<SomeThing>('key');

        expect(() => container.resolve(key)).toThrow();

        container.register(key, {
            factory: () => new SomeThing('lol'),
        });

        const instance = container.resolve(key);

        expect(instance).toEqual(new SomeThing('lol'));
    });

    describe('registration', () => {
        test('registering the same key twice is rejected', () => {
            container.register('pg.pool', {factory: () => new Dependency('pool')});

            expect(() => container.register('pg.pool', {factory: () => new Dependency('other')})).toThrow(
                'Dependency pg.pool is already registered',
            );
        });

        test('registering an instance for an existing key is rejected', () => {
            container.register('pg.pool', {factory: () => new Dependency('pool')});

            expect(() => container.registerInstance('pg.pool', {instance: new Dependency('other')})).toThrow(
                'Dependency pg.pool is already registered',
            );
        });

        test('registering a service for a key that holds an instance is rejected', () => {
            container.registerInstance('logger', {instance: new Dependency('logger')});

            expect(() => container.register('logger', {factory: () => new Dependency('other')})).toThrow(
                'Dependency logger is already registered',
            );
        });

        test('resolving an unregistered key names the key', () => {
            expect(() => container.resolve(forgeServiceKey<Dependency>('pg.pool'))).toThrow(
                'No definition found for key "pg.pool".',
            );
        });

        test('lazily resolving an unregistered key names the key', () => {
            expect(() => container.resolveLazy(forgeServiceKey<Dependency>('pg.pool'))).toThrow(
                'No definition found for key "pg.pool".',
            );
        });

        test('services can be registered after other services were resolved', () => {
            const poolKey = container.register('pool', {factory: () => new Dependency('pool')});

            container.resolve(poolKey);

            const repositoryKey = container.register('repository', {
                factory: c => new Middle('repository', c.resolve(poolKey)),
            });

            expect(container.resolve(repositoryKey).inner).toBe(container.resolve(poolKey));
        });

        test('registers a service under a name that also exists on Object.prototype', () => {
            const key = container.register<Dependency>('valueOf', {factory: () => new Dependency('valueOf')});

            expect(container.resolve(key).name).toEqual('valueOf');
        });

        test('reports a missing definition for a name that also exists on Object.prototype', () => {
            expect(() => container.resolve(forgeServiceKey<Dependency>('toString'))).toThrow(
                'No definition found for key "toString".',
            );
        });

        // see .claude-work/issues/dependency-injection-lazy-definition-is-mutated-on-registration.md
        it.fails('keeps two containers independent when a lazy definition is registered in both', async () => {
            const cleaned: string[] = [];
            let count = 0;
            const definition = {
                lazy: true as const,
                factory: () => new Dependency(`instance-${++count}`),
                cleanup: (instance: Dependency) => {
                    cleaned.push(instance.name);
                },
            };
            const first = new DependencyContainer();
            const second = new DependencyContainer();
            const firstKey = first.register<Dependency>('service', definition);
            const secondKey = second.register<Dependency>('service', definition);

            expect(first.resolve(firstKey).name).toEqual('instance-1');
            expect(second.resolve(secondKey).name).toEqual('instance-2');

            await first.cleanup();
            await second.cleanup();

            expect(cleaned.toSorted()).toEqual(['instance-1', 'instance-2']);
        });
    });

    describe('resolution graph', () => {
        let segments: string[];
        let poolConstructions: number;
        let poolKey: ServiceKey<Dependency>;

        const trackCleanup = (instance: {name: string}) => {
            segments.push(instance.name);
        };

        beforeEach(() => {
            segments = [];
            poolConstructions = 0;
            poolKey = container.register('pool', {
                factory: () => new Dependency(`pool-${++poolConstructions}`),
                cleanup: trackCleanup,
            });
        });

        test('a dependency shared by two consumers is constructed once and shut down last', async () => {
            const leftKey = container.register('left', {
                factory: c => new Middle('left', c.resolve(poolKey)),
                cleanup: trackCleanup,
            });
            const rightKey = container.register('right', {
                factory: c => new Middle('right', c.resolve(poolKey)),
                cleanup: trackCleanup,
            });
            const topKey = container.register<{name: string; left: Middle; right: Middle}>('top', {
                factory: c => ({
                    name: 'top',
                    left: c.resolve(leftKey),
                    right: c.resolve(rightKey),
                }),
                cleanup: trackCleanup,
            });

            const top = container.resolve(topKey);

            expect(poolConstructions).toEqual(1);
            expect(top.left.inner).toBe(top.right.inner);

            await container.cleanup();

            expect(segments).toEqual(['top', 'left', 'right', 'pool-1']);
        });

        test('a deep dependency chain is shut down from the outside in', async () => {
            const depth = 40;
            let previousKey = poolKey;

            for (let level = 0; level < depth; level++) {
                const name = `level-${level}`;
                const dependency = previousKey;
                previousKey = container.register<Dependency>(name, {
                    factory: c => {
                        c.resolve(dependency);

                        return new Dependency(name);
                    },
                    cleanup: trackCleanup,
                });
            }

            container.resolve(previousKey);

            await container.cleanup();

            expect(segments).toHaveLength(depth + 1);
            expect(segments[0]).toEqual(`level-${depth - 1}`);
            expect(segments.at(-1)).toEqual('pool-1');
        });

        test('a transient service is constructed for every resolution', () => {
            let constructions = 0;
            const key = container.register<Dependency>('transient', {
                cache: false,
                factory: () => new Dependency(`transient-${++constructions}`),
            });

            expect(container.resolve(key).name).toEqual('transient-1');
            expect(container.resolve(key).name).toEqual('transient-2');
        });

        test('a transient service attributes its dependencies to its consumer', async () => {
            const transientKey = container.register<Middle>('transient', {
                cache: false,
                factory: c => new Middle('transient', c.resolve(poolKey)),
            });
            const consumerKey = container.register('consumer', {
                factory: c => new Outer('consumer', c.resolve(transientKey)),
                cleanup: trackCleanup,
            });

            container.resolve(consumerKey);

            await container.cleanup();

            expect(segments).toEqual(['consumer', 'pool-1']);
        });

        test('a service consuming a registered instance is shut down before it', async () => {
            const loggerKey = container.registerInstance('logger', {
                instance: new Dependency('logger'),
                cleanup: trackCleanup,
            });
            const repositoryKey = container.register('repository', {
                factory: c => new Middle('repository', c.resolve(loggerKey)),
                cleanup: trackCleanup,
            });

            container.resolve(repositoryKey);

            await container.cleanup();

            expect(segments).toEqual(['repository', 'logger']);
        });

        test('a failure deep in the graph surfaces the original error', () => {
            const innerKey = container.register<Dependency>('inner', {
                factory: () => {
                    throw new Error('database unavailable');
                },
            });
            const middleKey = container.register('middle', {
                factory: c => new Middle('middle', c.resolve(innerKey)),
            });
            const outerKey = container.register('outer', {
                factory: c => new Outer('outer', c.resolve(middleKey)),
            });

            expect(() => container.resolve(outerKey)).toThrow('database unavailable');
        });

        test('reports the factory failure again when a failed resolution is retried', () => {
            const key = container.register<Dependency>('broken', {
                factory: () => {
                    throw new Error('database unavailable');
                },
            });

            expect(() => container.resolve(key)).toThrow('database unavailable');
            expect(() => container.resolve(key)).toThrow('database unavailable');
        });

        test('a key stays resolvable after its proxy failed to construct the service', () => {
            let attempts = 0;
            const key = container.register<Dependency>('flaky', {
                factory: () => {
                    if (++attempts === 1) {
                        throw new Error('database unavailable');
                    }

                    return new Dependency('flaky');
                },
            });
            const proxy = container.resolveLazy(key);

            expect(() => proxy.name).toThrow('database unavailable');

            const instance = container.resolve(key);

            expect(isProxy(instance)).toEqual(false);
            expect(instance.name).toEqual('flaky');
        });

        // see .claude-work/issues/dependency-injection-circular-proxy-dereferenced-during-construction.md
        it.fails('hands every consumer the same instance when a circular proxy is used during construction', () => {
            interface MemberIndex {
                names: string[];
            }
            interface Member {
                name: string;
                index: MemberIndex;
            }

            let constructions = 0;
            // eslint-disable-next-line prefer-const
            let indexKey: ServiceKey<MemberIndex>;
            const memberKey = container.register<Member>('member', {
                // the index is only stored here, but the index uses the member while constructing
                factory: c => ({name: `member-${++constructions}`, index: c.resolve(indexKey)}),
            });
            indexKey = container.register<MemberIndex>('index', {
                factory: c => ({names: [c.resolve(memberKey).name]}),
            });

            const member = container.resolve(memberKey);
            const index = container.resolve(indexKey);

            expect(constructions).toEqual(1);
            expect(index.names).toEqual([member.name]);
        });

        // see .claude-work/issues/dependency-injection-circular-proxy-dereferenced-during-construction.md
        it.fails('reports a circular dependency when both services are used during construction', () => {
            // eslint-disable-next-line prefer-const
            let rightKey: ServiceKey<Dependency>;
            const leftKey = container.register<Dependency>('left', {
                factory: c => new Dependency(`left of ${c.resolve(rightKey).name}`),
            });
            rightKey = container.register<Dependency>('right', {
                factory: c => new Dependency(`right of ${c.resolve(leftKey).name}`),
            });

            expect(() => container.resolve(leftKey)).toThrow(/circular/i);
        });

        // see .claude-work/issues/dependency-injection-lazy-transient-services-are-shared.md
        it.fails('constructs a new instance for every resolution of a lazy transient service', () => {
            let constructions = 0;
            const key = container.register<Dependency>('lazy-transient', {
                lazy: true,
                cache: false,
                factory: () => new Dependency(`instance-${++constructions}`),
            });

            expect(container.resolve(key).name).toEqual('instance-1');
            expect(container.resolve(key).name).toEqual('instance-2');
        });
    });

    describe('cleanup failures', () => {
        let segments: string[];

        beforeEach(() => (segments = []));

        test('shuts down a dependency when the service consuming it fails to shut down', async () => {
            const poolKey = container.register('pool', {
                factory: () => new Dependency('pool'),
                cleanup: () => {
                    segments.push('pool');
                },
            });
            const relayKey = container.register('relay', {
                factory: c => new Middle('relay', c.resolve(poolKey)),
                cleanup: async () => {
                    segments.push('relay');
                    throw new Error('relay refused to stop');
                },
            });

            container.resolve(relayKey);

            await expect(container.cleanup()).rejects.toThrow();

            expect(segments).toEqual(['relay', 'pool']);
        });

        test('shuts down the remaining services in a level when one hook throws synchronously', async () => {
            const brokenKey = container.register('broken', {
                factory: () => new Dependency('broken'),
                cleanup: () => {
                    segments.push('broken');
                    throw new Error('already closed');
                },
            });
            const healthyKey = container.register('healthy', {
                factory: () => new Dependency('healthy'),
                cleanup: () => {
                    segments.push('healthy');
                },
            });

            container.resolve(brokenKey);
            container.resolve(healthyKey);

            await expect(container.cleanup()).rejects.toThrow();

            expect(segments.toSorted()).toEqual(['broken', 'healthy']);
        });

        test('reports every shutdown failure, not only the first', async () => {
            for (const name of ['first', 'second']) {
                const key = container.register(name, {
                    factory: () => new Dependency(name),
                    cleanup: async () => {
                        throw new Error(`${name} failed to stop`);
                    },
                });
                container.resolve(key);
            }

            const failure = await container.cleanup().then(
                () => undefined,
                (error: unknown) => error,
            );

            expect(failure).toBeInstanceOf(CleanupFailed);
            expect((failure as CleanupFailed).errors.map((error: Error) => error.message).toSorted()).toEqual([
                'first failed to stop',
                'second failed to stop',
            ]);
            expect((failure as CleanupFailed).failures.map(({service}) => service).toSorted()).toEqual([
                'first',
                'second',
            ]);
        });

        test('forgets what it shut down when a hook failed, so a later cleanup runs no hook twice', async () => {
            const poolKey = container.register('pool', {
                factory: () => new Dependency('pool'),
                cleanup: () => {
                    segments.push('pool');
                },
            });
            const relayKey = container.register('relay', {
                factory: c => new Middle('relay', c.resolve(poolKey)),
                cleanup: () => {
                    segments.push('relay');
                    throw new Error('relay refused to stop');
                },
            });

            container.resolve(relayKey);

            await expect(container.cleanup()).rejects.toBeInstanceOf(CleanupFailed);
            await container.cleanup();

            expect(segments).toEqual(['relay', 'pool']);
        });
    });

    describe('cleanup lifecycle', () => {
        let segments: string[];
        let poolConstructions: number;
        let poolKey: ServiceKey<Dependency>;

        const trackCleanup = (instance: {name: string}) => {
            segments.push(instance.name);
        };

        beforeEach(() => {
            segments = [];
            poolConstructions = 0;
            poolKey = container.register('pool', {
                factory: () => new Dependency(`pool-${++poolConstructions}`),
                cleanup: trackCleanup,
            });
        });

        test('cleaning up twice shuts every service down once', async () => {
            container.resolve(poolKey);

            await container.cleanup();
            await container.cleanup();

            expect(segments).toEqual(['pool-1']);
        });

        test('a service resolved after a cleanup is constructed again', async () => {
            const first = container.resolve(poolKey);

            await container.cleanup();

            const second = container.resolve(poolKey);

            expect(second).not.toBe(first);
            expect(second.name).toEqual('pool-2');

            await container.cleanup();

            expect(segments).toEqual(['pool-1', 'pool-2']);
        });

        test('a lazy proxy that was already used keeps serving its instance after a cleanup', async () => {
            const lazyKey = container.register<Dependency>('lazy', {
                lazy: true,
                factory: () => new Dependency(`lazy-${++poolConstructions}`),
                cleanup: trackCleanup,
            });

            const proxy = container.resolve(lazyKey);

            expect(proxy.name).toEqual('lazy-1');

            await container.cleanup();

            expect(segments).toEqual(['lazy-1']);
            expect(proxy.name).toEqual('lazy-1');

            await container.cleanup();

            expect(segments).toEqual(['lazy-1']);
        });

        // see .claude-work/issues/dependency-injection-container-remains-usable-after-cleanup.md
        it.fails('does not shut a registered instance down twice when it is resolved after a cleanup', async () => {
            const instanceKey = container.registerInstance('broker', {
                instance: new Dependency('broker'),
                cleanup: trackCleanup,
            });

            await container.cleanup();

            container.resolve(instanceKey);

            await container.cleanup();

            expect(segments).toEqual(['broker']);
        });

        // see .claude-work/issues/dependency-injection-concurrent-cleanup-runs-every-hook-twice.md
        test('runs every shutdown hook once when cleanup is called concurrently', async () => {
            const closed = Promise.withResolvers<void>();
            container.register('relay', {
                factory: () => new Dependency('relay'),
                cleanup: async instance => {
                    trackCleanup(instance);
                    await closed.promise;
                },
            });

            container.resolve(forgeServiceKey<Dependency>('relay'));
            container.resolve(poolKey);

            const shutdowns = [container.cleanup(), container.cleanup()];
            closed.resolve();

            await Promise.all(shutdowns);

            expect(segments.toSorted()).toEqual(['pool-1', 'relay']);
        });

        test('a cleanup called while another one runs settles only when the running one has finished', async () => {
            // Joining rather than returning early: a signal handler that awaits cleanup() before
            // exiting must not exit while the first trigger's hooks are still shutting things down.
            const closed = Promise.withResolvers<void>();
            container.register('relay', {
                factory: () => new Dependency('relay'),
                cleanup: async () => {
                    await closed.promise;
                },
            });
            container.resolve(forgeServiceKey<Dependency>('relay'));
            container.resolve(poolKey);

            const first = container.cleanup();
            let secondSettled = false;
            const second = container.cleanup().then(() => {
                secondSettled = true;
            });

            await new Promise(resolve => setImmediate(resolve));
            expect(secondSettled).toBe(false);

            closed.resolve();
            await Promise.all([first, second]);

            expect(secondSettled).toBe(true);
            expect(segments).toEqual(['pool-1']);
        });

        // see .claude-work/issues/dependency-injection-services-resolved-during-cleanup-are-never-shut-down.md
        it.fails('shuts down a service that was resolved while a cleanup was in progress', async () => {
            const closed = Promise.withResolvers<void>();
            const relayKey = container.register('relay', {
                factory: () => new Dependency('relay'),
                cleanup: async instance => {
                    trackCleanup(instance);
                    await closed.promise;
                },
            });

            container.resolve(relayKey);

            const shutdown = container.cleanup();

            container.resolve(poolKey);
            closed.resolve();

            await shutdown;
            await container.cleanup();

            expect(segments.toSorted()).toEqual(['pool-1', 'relay']);
        });

        // see .claude-work/issues/dependency-injection-services-resolved-during-cleanup-are-never-shut-down.md
        it.fails('shuts down an instance that was created while a cleanup was in progress', async () => {
            const closed = Promise.withResolvers<void>();
            const relayKey = container.register('relay', {
                factory: () => new Dependency('relay'),
                cleanup: async instance => {
                    trackCleanup(instance);
                    await closed.promise;
                },
            });

            container.resolve(relayKey);

            const shutdown = container.cleanup();

            container.createInstance({
                factory: () => new Dependency('worker'),
                cleanup: trackCleanup,
            });
            closed.resolve();

            await shutdown;
            await container.cleanup();

            expect(segments.toSorted()).toEqual(['relay', 'worker']);
        });
    });

    describe('circular dependencies', () => {
        interface Dispatcher {
            name: string;
            self: Dispatcher;
        }

        interface Member {
            name: string;
            collection: Collection;
        }

        interface Collection {
            name: string;
            members: Member[];
        }

        let segments: string[];

        const trackCleanup = (instance: {name: string}) => {
            segments.push(instance.name);
        };

        beforeEach(() => (segments = []));

        test('shuts down a service that resolves itself lazily', async () => {
             
            let dispatcherKey: ServiceKey<Dispatcher>;
            dispatcherKey = container.register<Dispatcher>('dispatcher', {
                factory: c => ({name: 'dispatcher', self: c.resolveLazy(dispatcherKey)}),
                cleanup: trackCleanup,
            });

            const dispatcher = container.resolve(dispatcherKey);

            expect(dispatcher.self.name).toEqual('dispatcher');

            await container.cleanup();

            expect(segments).toEqual(['dispatcher']);
        });

        test('shuts down a service in a cycle whose other members have nothing to shut down', async () => {
            // eslint-disable-next-line prefer-const
            let collectionKey: ServiceKey<Collection>;
            const memberKey = container.register<Member>('member', {
                factory: c => ({name: 'member', collection: c.resolve(collectionKey)}),
                cleanup: trackCleanup,
            });
            collectionKey = container.register<Collection>('collection', {
                factory: c => ({name: 'collection', members: [c.resolveLazy(memberKey)]}),
            });

            const member = container.resolve(memberKey);

            expect(member.collection.members[0]?.name).toEqual('member');

            await container.cleanup();

            expect(segments).toEqual(['member']);
        });
    });

    describe('documented examples', () => {
        class MyLastNameService {
            constructor(public readonly lastName: string) {}
        }

        class MyNameService {
            constructor(
                private readonly firstName: string,
                private readonly dependency: MyLastNameService,
            ) {}

            fullName(): string {
                return `${this.firstName} ${this.dependency.lastName}`;
            }
        }

        class Something {
            constructor(
                public readonly name: string,
                private readonly collection: SomeCollection,
            ) {}

            allNames(): string[] {
                return this.collection.allNames();
            }
        }

        class SomeCollection {
            constructor(
                public readonly name: string,
                private readonly members: Something[],
            ) {}

            allNames(): string[] {
                return this.members.map(member => member.name);
            }
        }

        test('the usage example composes a service from an instance', () => {
            const myLastNameService = container.registerInstance<MyLastNameService>('my.last_name_service', {
                instance: new MyLastNameService('de Jonge'),
            });
            const myNameService = container.register<MyNameService>('my.name_service', {
                factory: c => new MyNameService('Frank', c.resolve(myLastNameService)),
            });

            expect(container.resolve(myNameService).fullName()).toEqual('Frank de Jonge');
        });

        test('the alternative lazy example breaks the cycle with resolveLazy', () => {
            // eslint-disable-next-line prefer-const
            let collectionToken: ServiceKey<SomeCollection>;
            const somethingToken = container.register<Something>('something', {
                factory: c => new Something('something-name', c.resolveLazy(collectionToken)),
            });
            collectionToken = container.register<SomeCollection>('collection', {
                factory: c => new SomeCollection('collection-name', [c.resolve(somethingToken)]),
            });

            expect(container.resolve(somethingToken).allNames()).toEqual(['something-name']);
        });

        test('registers the collection from the documented lazy example', () => {
            // The README's `lazy: true` example, verbatim: the collection is registered under its
            // own key and handed out as a proxy, so the cycle resolves on first use. The explicit
            // token types break the type-level inference cycle the value-level laziness allows.
            const collectionToken: ServiceKey<SomeCollection> = container.register<SomeCollection>('collection', {
                lazy: true,
                factory: c => new SomeCollection('collection-name', [c.resolve(somethingToken)]),
            });

            const somethingToken: ServiceKey<Something> = container.register<Something>('something', {
                factory: c => new Something('something-name', c.resolve(collectionToken)),
            });

            expect(container.resolve(somethingToken).allNames()).toEqual(['something-name']);
        });
    });

    describe('created instances used per unit of work', () => {
        let segments: string[];
        let poolKey: ServiceKey<Dependency>;

        const trackCleanup = (instance: {name: string}) => {
            segments.push(instance.name);
        };

        beforeEach(() => {
            segments = [];
            poolKey = container.register('pool', {
                factory: () => new Dependency('pool'),
                cleanup: trackCleanup,
            });
        });

        test('two instances created from the same factory are never shared', () => {
            const factory = (c: DependencyContainer) => new Middle('worker', c.resolve(poolKey));

            const first = container.createInstance({factory, cleanup: trackCleanup});
            const second = container.createInstance({factory, cleanup: trackCleanup});

            expect(first).not.toBe(second);
            expect(first.inner).toBe(second.inner);
        });

        test('an instance created without dependencies is shut down on its own', async () => {
            container.createInstance({
                factory: () => new Dependency('worker'),
                cleanup: trackCleanup,
            });

            await container.cleanup();

            expect(segments).toEqual(['worker']);
        });

        test('a created instance whose factory throws does not break later shutdowns', async () => {
            expect(() =>
                container.createInstance({
                    factory: c => {
                        c.resolve(poolKey);
                        throw new Error('worker could not start');
                    },
                    cleanup: trackCleanup,
                }),
            ).toThrow('worker could not start');

            const worker = container.createInstance({
                factory: c => new Middle('worker', c.resolve(poolKey)),
                cleanup: trackCleanup,
            });

            expect(worker.name).toEqual('worker');

            await container.cleanup();

            expect(segments).toEqual(['worker', 'pool']);
        });
    });
});

class Dependency {
    constructor(public readonly name: string) {}
}

class Middle {
    constructor(
        public readonly name: string,
        public readonly inner: Dependency,
    ) {}
}

class Outer {
    constructor(
        public readonly name: string,
        public readonly middle: Middle,
    ) {}
}
