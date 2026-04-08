import {
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
