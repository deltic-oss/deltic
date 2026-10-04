import {decorateInstance} from './index.js';

describe('decorating methods of another object with ease', () => {
    test('decorating an instance partially', async () => {
        const instance = new SomeClass();
        const decorated = decorateInstance(instance, {
            patchedMethod: (inner, ...args) => {
                return inner(...args).padEnd(5, '-');
            },
            patchedAsyncMethod: async (inner, ...args) => {
                const s = await inner(...args);

                return s.padEnd(5, '_');
            },
        });

        // handled sync method decoration
        expect(decorated.patchedMethod(10)).toEqual('10---');

        // handled async method decoration
        expect(await decorated.patchedAsyncMethod(10)).toEqual('10___');

        // doesn't mess with internal routing of methods
        expect(await instance.asyncMethod(10)).toEqual('10');
        expect(await decorated.asyncMethod(10)).toEqual('10');
    });

    test('properties that are not methods are read from the instance', () => {
        const decorated = decorateInstance(new SomeClass(), {});

        expect(decorated.label).toEqual('some');
        expect(decorated.shout).toEqual('SOME');
        expect((decorated as unknown as Record<string, unknown>)['missing']).toBeUndefined();
    });

    test('a decorated instance can be returned from an async function', async () => {
        const provide = async () => decorateInstance(new SomeClass(), {});

        const decorated = await provide();

        expect(decorated.patchedMethod(10)).toEqual('10');
    });

    test('symbol-keyed methods keep working', () => {
        const decorated = decorateInstance(new SomeClass(), {});

        expect([...decorated]).toEqual([1, 2]);
    });
});

class SomeClass {
    label = 'some';

    get shout(): string {
        return this.label.toUpperCase();
    }

    patchedMethod(num: number): string {
        return String(num);
    }

    async asyncMethod(num: number): Promise<string> {
        return this.patchedMethod(num);
    }

    async patchedAsyncMethod(num: number): Promise<string> {
        return this.patchedMethod(num);
    }

    *[Symbol.iterator](): Generator<number> {
        yield 1;
        yield 2;
    }
}
