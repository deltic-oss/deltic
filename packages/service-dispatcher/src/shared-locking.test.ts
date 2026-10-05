import {
    type AnyInputForService,
    type Service,
    ServiceDispatcher,
    type ServiceHandlers,
} from '@deltic/service-dispatcher';
import {createServiceLockingMiddleware} from './locking-middleware.js';
import {MutexUsingMemory} from '@deltic/mutex/memory';
import {ServiceLocking} from './locking-decorator.js';
import {defaultLockTimeoutMs, type ServiceLockingOptions} from './shared-for-locking.js';
import {setTimeout as wait} from 'timers/promises';
import {type DynamicMutex, UnableToAcquireLock} from '@deltic/mutex';

interface ExampleService {
    ping: {
        payload: {
            id: string;
            returnThis: string;
        };
        response: {
            value: string;
        };
    };
    pong: {
        payload: {
            id: string;
            returnWhat: string;
        };
        response: {
            returned: string;
        };
    };
    excluded: {
        payload: {
            id: string;
            value: string;
        };
        response: string;
    };
    failing: {
        payload: {
            id: string;
        };
        response: void;
    };
}

const commandFailure = new Error('the command failed');

class RecordingMutex implements DynamicMutex<string> {
    public readonly acquisitions: {id: string; timeoutMs: number | undefined}[] = [];
    public readonly releases: string[] = [];
    public failReleaseWith: Error | undefined = undefined;

    async lock(id: string, timeoutMs?: number): Promise<void> {
        this.acquisitions.push({id, timeoutMs});
    }

    async unlock(id: string): Promise<void> {
        this.releases.push(id);

        if (this.failReleaseWith) {
            throw this.failReleaseWith;
        }
    }

    async tryLock(): Promise<boolean> {
        return true;
    }

    get lockedIds(): string[] {
        return this.acquisitions.map(acquisition => acquisition.id);
    }
}

describe.each([
    [
        'middleware',
        (handlers: ServiceHandlers<ExampleService>, options: ServiceLockingOptions<ExampleService, string>) =>
            new ServiceDispatcher(handlers, [createServiceLockingMiddleware(options)]),
    ],
    [
        'decorator',
        (handlers: ServiceHandlers<ExampleService>, options: ServiceLockingOptions<ExampleService, string>) =>
            new ServiceLocking(new ServiceDispatcher(handlers), options),
    ],
] as const)('@deltic/service-locking using %s', (_name, factory) => {
    let service: Service<ExampleService>;
    let segments: string[];
    let mutex: MutexUsingMemory<string>;

    const createHandlers = (
        overrides: Partial<ServiceHandlers<ExampleService>> = {},
    ): ServiceHandlers<ExampleService> => ({
        ping: async payload => {
            segments.push(payload.returnThis);
            await wait(5);
            segments.push(payload.returnThis);

            return {
                value: payload.returnThis,
            };
        },
        pong: async payload => {
            segments.push(payload.returnWhat);
            await wait(5);
            segments.push(payload.returnWhat);

            return {
                returned: payload.returnWhat,
            };
        },
        excluded: async payload => {
            segments.push(payload.value);
            await wait(5);
            segments.push(payload.value);

            return payload.value;
        },
        failing: async () => {
            throw commandFailure;
        },
        ...overrides,
    });

    beforeEach(() => {
        segments = [];
        mutex = new MutexUsingMemory<string>();
        service = factory(createHandlers(), {
            mutex,
            lockResolver: input => input.payload.id,
            shouldSkip: input => input.type === 'excluded',
        });
    });

    test('dispatching two different commands at the same time for the same lock', async () => {
        await Promise.all([
            service.handle({type: 'ping', payload: {
                id: 'one',
                returnThis: 'first',
            }}),
            service.handle({type: 'pong', payload: {
                id: 'one',
                returnWhat: 'second',
            }}),
        ]);

        expect(segments).toEqual(['first', 'first', 'second', 'second']);
    });

    test('dispatching two different commands at the same time for a different lock', async () => {
        await Promise.all([
            service.handle({type: 'ping', payload: {
                id: 'two',
                returnThis: 'first',
            }}),
            service.handle({type: 'pong', payload: {
                id: 'three',
                returnWhat: 'second',
            }}),
        ]);

        expect(segments).toEqual(['first', 'second', 'first', 'second']);
    });

    test('dispatching concurrently on the same lock, but locking is skipped', async () => {
        await Promise.all([
            service.handle({type: 'excluded', payload: {
                id: 'two',
                value: 'first',
            }}),
            service.handle({type: 'pong', payload: {
                id: 'three',
                returnWhat: 'second',
            }}),
        ]);

        expect(segments).toEqual(['first', 'second', 'first', 'second']);
    });

    test('the lock is released when the command handler throws', async () => {
        await expect(service.handle({type: 'failing', payload: {id: 'one'}})).rejects.toThrow(commandFailure);

        await service.handle({type: 'ping', payload: {id: 'one', returnThis: 'after the failure'}});

        expect(segments).toEqual(['after the failure', 'after the failure']);
    });

    test('the lock is acquired and released exactly once per dispatch', async () => {
        const recordingMutex = new RecordingMutex();
        const recordingService = factory(createHandlers(), {
            mutex: recordingMutex,
            lockResolver: input => input.payload.id,
        });

        await recordingService.handle({type: 'ping', payload: {id: 'one', returnThis: 'value'}});

        expect(recordingMutex.lockedIds).toEqual(['one']);
        expect(recordingMutex.releases).toEqual(['one']);
    });

    test('no lock is acquired at all when locking is skipped', async () => {
        const recordingMutex = new RecordingMutex();
        const skippingService = factory(createHandlers(), {
            mutex: recordingMutex,
            lockResolver: input => input.payload.id,
            shouldSkip: () => true,
        });

        await skippingService.handle({type: 'ping', payload: {id: 'one', returnThis: 'value'}});

        expect(recordingMutex.lockedIds).toEqual([]);
        expect(recordingMutex.releases).toEqual([]);
    });

    test('no lock is acquired when the lock resolver throws', async () => {
        const recordingMutex = new RecordingMutex();
        const failure = new Error('unable to determine the lock id');
        const failingResolverService = factory(createHandlers(), {
            mutex: recordingMutex,
            lockResolver: () => {
                throw failure;
            },
        });

        await expect(
            failingResolverService.handle({type: 'ping', payload: {id: 'one', returnThis: 'value'}}),
        ).rejects.toThrow(failure);
        expect(recordingMutex.lockedIds).toEqual([]);
        expect(segments).toEqual([]);
    });

    test('a failure to release the lock surfaces even though the command succeeded', async () => {
        const recordingMutex = new RecordingMutex();
        recordingMutex.failReleaseWith = new Error('the lock could not be released');
        const recordingService = factory(createHandlers(), {
            mutex: recordingMutex,
            lockResolver: input => input.payload.id,
        });

        await expect(
            recordingService.handle({type: 'ping', payload: {id: 'one', returnThis: 'value'}}),
        ).rejects.toThrow('the lock could not be released');
        expect(segments).toEqual(['value', 'value']);
    });

    test('acquiring the lock fails when the holder does not release it within the timeout', async () => {
        const release = Promise.withResolvers<void>();
        const blockingService = factory(
            createHandlers({
                ping: async payload => {
                    await release.promise;

                    return {value: payload.returnThis};
                },
            }),
            {
                mutex,
                lockResolver: input => input.payload.id,
                timeoutMs: 20,
            },
        );

        const holding = blockingService.handle({type: 'ping', payload: {id: 'one', returnThis: 'holder'}});

        await expect(
            blockingService.handle({type: 'ping', payload: {id: 'one', returnThis: 'waiting'}}),
        ).rejects.toThrow(UnableToAcquireLock);

        release.resolve();
        await expect(holding).resolves.toEqual({value: 'holder'});
    });

    test('dispatching for the same lock from within a command handler times out', async () => {
        let reentrantService: Service<ExampleService>;
        reentrantService = factory(
            createHandlers({
                ping: async payload => {
                    await reentrantService.handle({
                        type: 'pong',
                        payload: {id: payload.id, returnWhat: 'from within'},
                    });

                    return {value: payload.returnThis};
                },
            }),
            {
                mutex,
                lockResolver: input => input.payload.id,
                timeoutMs: 20,
            },
        );

        await expect(
            reentrantService.handle({type: 'ping', payload: {id: 'one', returnThis: 'outer'}}),
        ).rejects.toThrow(UnableToAcquireLock);
    });
});

describe('lock timeout configuration', () => {
    interface SingleCommandService {
        do_something: {payload: {id: string}; response: string};
    }

    const handlers: ServiceHandlers<SingleCommandService> = {
        do_something: async () => 'done',
    };

    test('the decorator falls back to the default lock timeout', async () => {
        const mutex = new RecordingMutex();
        const service = new ServiceLocking<SingleCommandService, string>(
            new ServiceDispatcher<SingleCommandService>(handlers),
            {
                mutex,
                lockResolver: input => input.payload.id,
            },
        );

        await service.handle({type: 'do_something', payload: {id: 'one'}});

        expect(mutex.acquisitions).toEqual([{id: 'one', timeoutMs: defaultLockTimeoutMs}]);
    });

    // see .claude-work/issues/service-dispatcher-locking-middleware-waits-forever.md
    it.fails('the middleware falls back to the default lock timeout', async () => {
        const mutex = new RecordingMutex();
        const service = new ServiceDispatcher(handlers, [
            createServiceLockingMiddleware<SingleCommandService, string>({
                mutex,
                lockResolver: input => input.payload.id,
            }),
        ]);

        await service.handle({type: 'do_something', payload: {id: 'one'}});

        expect(mutex.acquisitions).toEqual([{id: 'one', timeoutMs: defaultLockTimeoutMs}]);
    });

    test('a configured timeout is passed to the mutex by both implementations', async () => {
        const forMiddleware = new RecordingMutex();
        const forDecorator = new RecordingMutex();
        const options = {
            lockResolver: (input: AnyInputForService<SingleCommandService>) => input.payload.id,
            timeoutMs: 1234,
        };
        const middlewareService = new ServiceDispatcher<SingleCommandService>(handlers, [
            createServiceLockingMiddleware<SingleCommandService, string>({...options, mutex: forMiddleware}),
        ]);
        const decoratorService = new ServiceLocking<SingleCommandService, string>(
            new ServiceDispatcher<SingleCommandService>(handlers),
            {
                ...options,
                mutex: forDecorator,
            },
        );

        await middlewareService.handle({type: 'do_something', payload: {id: 'one'}});
        await decoratorService.handle({type: 'do_something', payload: {id: 'one'}});

        expect(forMiddleware.acquisitions).toEqual([{id: 'one', timeoutMs: 1234}]);
        expect(forDecorator.acquisitions).toEqual(forMiddleware.acquisitions);
    });
});
