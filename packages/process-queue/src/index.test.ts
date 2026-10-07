import {
    ConcurrentProcessQueue,
    PartitionedProcessQueue,
    type ProcessQueue,
    type ProcessQueueOptions,
    SequentialProcessQueue,
    TaskWasPurged,
} from './index.js';
import {WaitGroup} from '@deltic/wait-group';

type Factory = <T>(options: ProcessQueueOptions<T>) => ProcessQueue<T>;

const createSequentialProcessor = <T>(options: ProcessQueueOptions<T>): ProcessQueue<T> =>
    new SequentialProcessQueue<T>(options);

const createConcurrentProcessor = <T>(options: ProcessQueueOptions<T>): ProcessQueue<T> =>
    new ConcurrentProcessQueue<T>(options);

const createPartitionedProcessor = <T>(options: ProcessQueueOptions<T>): ProcessQueue<T> =>
    new PartitionedProcessQueue<T>(() => new SequentialProcessQueue<T>(options), () => 0, 1);

describe.each([
    ['sequential', createSequentialProcessor],
    ['concurrent', createConcurrentProcessor],
    ['partitioned', createPartitionedProcessor],
])('@deltic/process-queue %s', (_type: string, factory: Factory) => {
    test('pushing a task on the queue returns a promise that resolves the task when completed', async () => {
        const processor = new AppendingProcessor();
        const processQueue = factory({
            onError: async () => {
                throw new Error('No error handler defined');
            },
            processor: processor.process,
        });
        const task = await processQueue.push('a');
        expect(task).toEqual('a');
        await processQueue.stop();
    });

    test('it supports not auto starting', async () => {
        const processor = new AppendingProcessor();
        const processQueue = factory({
            autoStart: false,
            onError: async () => {
                throw new Error('No error handler defined');
            },
            processor: processor.process,
        });

        expect(processQueue.isProcessing()).toEqual(false);
    });

    test('it can be started manually', async () => {
        const processor = new AppendingProcessor();
        const {promise, resolve} = Promise.withResolvers<void>();
        let count = 0;
        const processQueue: ProcessQueue<string> = factory({
            autoStart: false,
            onError: async () => {
                throw new Error('No error handler defined');
            },
            processor: async value => {
                await processor.process(value);
                count++;

                if (count >= 3) {
                    resolve();
                }
            },
        });
        processQueue.push('a');
        processQueue.push('b');
        processQueue.push('c');
        processQueue.start();
        await promise;
        expect(processor.value).toContain('a');
        expect(processor.value).toContain('b');
        expect(processor.value).toContain('c');
    });

    test('it calls an onError hook that receives thrown errors', async () => {
        const {promise, resolve} = Promise.withResolvers<void>();
        let errors = 0;
        const processQueue = factory({
            stopOnError: true,
            onError: async () => {
                errors = 1;
                resolve();
            },
            processor: async () => {
                throw new Error('no!');
            },
        });
        processQueue.push('a').catch(() => {});
        await promise;
        expect(errors).toEqual(1);
        await processQueue.stop();
    });

    test('it calls an onError hook when a promise is rejected', async () => {
        const promise = Promise.withResolvers<void>();
        let errors = 0;
        const processQueue = factory({
            onError: async ({queue}) => {
                errors++;
                await queue.stop();
                promise.resolve();
            },
            processor: () => Promise.reject(new Error('reason')),
        });
        processQueue.push('a').catch(() => {});
        await promise.promise;
        expect(errors).toEqual(1);
    });

    test('a task can be skipped on error', async () => {
        let tries = 0;
        const {promise, resolve} = Promise.withResolvers<void>();
        const processQueue = factory({
            onError: async ({skipCurrentTask}) => {
                skipCurrentTask();
            },
            onDrained: async () => {
                resolve();
            },
            processor: async () => {
                tries++;
                throw new Error('failing');
            },
        });
        processQueue.push('a');
        processQueue.push('b');
        await promise;
        await processQueue.stop();
        expect(tries).toEqual(2);
    });

    test('skipping on error rejects the promise', async () => {
        const processQueue = factory({
            onError: async ({skipCurrentTask}) => {
                skipCurrentTask();
            },
            processor: async () => {
                throw new Error('failing');
            },
        });

        await expect(processQueue.push('a')).rejects.toEqual(new Error('failing'));
        await processQueue.stop();
    });

    test('stopping the queue in the same event loop cycle prevents tasks from being processed', async () => {
        let processed = 0;
        const processQueue = factory({
            onError: async ({skipCurrentTask}) => {
                skipCurrentTask();
            },
            processor: async () => {
                processed++;
            },
        });
        processQueue.push('a');
        processQueue.push('b');
        await processQueue.stop();
        expect(processed).toEqual(0);
    });

    test('purging prevents the next task(s) from being handled', async () => {
        let tries = 0;
        const processQueue = factory({
            onError: async () => {},
            processor: async () => {
                tries++;
            },
        });
        processQueue.push('a');
        processQueue.push('b');
        await processQueue.purge();
        expect(tries).toEqual(0);
    });

    test('when a job is completed the onFinish hook is called', async () => {
        let called = false;
        const {promise, resolve} = Promise.withResolvers<void>();
        const processQueue = factory({
            onError: async () => {},
            onFinish: async () => {
                called = true;
                resolve();
            },
            processor: async () => {},
        });
        processQueue.push('something');
        await promise;
        expect(called).toBe(true);
    });

    test('when a job errors the onFinish hook is NOT called', async () => {
        let called = false;
        const {promise, resolve} = Promise.withResolvers<void>();
        const processQueue = factory({
            onError: async () => {
                resolve();
            },
            onFinish: async () => {
                called = true;
            },
            processor: async () => {
                throw new Error('oh no');
            },
        });
        processQueue.push('something').catch(() => {});
        await promise;
        await processQueue.stop();
        expect(called).toBe(false);
    });

    test('the error handler receives the failed task and the error that caused it', async () => {
        const failure = new Error('cannot process this task');
        const {promise, resolve} = Promise.withResolvers<void>();
        let received: {error: unknown; task: string} | undefined = undefined;
        const processQueue = factory<string>({
            onError: async ({error, task, skipCurrentTask}) => {
                received = {error, task};
                skipCurrentTask();
                resolve();
            },
            processor: async () => {
                throw failure;
            },
        });
        processQueue.push('a').catch(() => {});
        await promise;
        expect(received).toEqual({error: failure, task: 'a'});
        await processQueue.stop();
    });

    test('skipping a failing task leaves the tasks around it unaffected', async () => {
        const attempted: string[] = [];
        const outcomes: Record<string, string> = {};
        const processQueue = factory({
            maxProcessing: 1,
            onError: async ({skipCurrentTask}) => {
                skipCurrentTask();
            },
            processor: async (task: string) => {
                attempted.push(task);

                if (task === 'bad') {
                    throw new Error('cannot process this task');
                }
            },
        });
        await Promise.all(
            ['good-1', 'bad', 'good-2'].map(task =>
                processQueue.push(task).then(
                    completed => (outcomes[completed] = 'completed'),
                    () => (outcomes[task] = 'failed'),
                ),
            ),
        );
        expect(attempted).toEqual(['good-1', 'bad', 'good-2']);
        expect(outcomes).toEqual({'good-1': 'completed', bad: 'failed', 'good-2': 'completed'});
        await processQueue.stop();
    });

    test('stopping the queue waits for the task that is in flight', async () => {
        const processor = new GatedProcessor<string>();
        const processQueue = factory({
            onError: async () => {},
            processor: processor.process,
        });
        processQueue.push('a');
        await flushTicks();
        expect(processor.inFlight).toEqual(1);
        let stopped = false;
        void processQueue.stop().then(() => (stopped = true));
        await flushTicks();
        expect(stopped).toBe(false);
        processor.complete('a');
        await flushTicks();
        expect(stopped).toBe(true);
        expect(processor.settled).toEqual(['a']);
    });

    test('tasks pushed while the queue is stopped are processed once it is started again', async () => {
        const processed: string[] = [];
        const processQueue = factory({
            onError: async () => {},
            processor: async (task: string) => {
                processed.push(task);
            },
        });
        await processQueue.stop();
        processQueue.push('a');
        await flushTicks();
        expect(processed).toEqual([]);
        processQueue.start();
        await flushTicks();
        expect(processed).toEqual(['a']);
        await processQueue.stop();
    });

    test('a task pushed from within the processor is processed as well', async () => {
        const processed: string[] = [];
        const {promise, resolve} = Promise.withResolvers<void>();
        const processQueue: ProcessQueue<string> = factory({
            onError: async () => {},
            processor: async (task: string) => {
                processed.push(task);

                if (task === 'a') {
                    processQueue.push('a-follow-up');
                }

                if (task === 'a-follow-up') {
                    resolve();
                }
            },
        });
        processQueue.push('a');
        processQueue.push('b');
        await promise;
        expect(processed).toEqual(['a', 'b', 'a-follow-up']);
        await processQueue.stop();
    });

    test('the same task can be pushed more than once', async () => {
        const task = {id: 'duplicate'};
        const processed: {id: string}[] = [];
        const processQueue = factory<{id: string}>({
            onError: async () => {},
            processor: async value => {
                processed.push(value);
            },
        });
        const completed = await Promise.all([processQueue.push(task), processQueue.push(task)]);
        expect(processed).toEqual([task, task]);
        expect(completed).toEqual([task, task]);
        await processQueue.stop();
    });

    test('onDrained is called once after the last task of a batch is completed', async () => {
        let drained = 0;
        const processor = new GatedProcessor<string>();
        const processQueue = factory({
            maxProcessing: 2,
            onError: async () => {},
            onDrained: async () => {
                drained++;
            },
            processor: processor.process,
        });
        const pushed = [processQueue.push('a'), processQueue.push('b'), processQueue.push('c')];
        await flushTicks();
        expect(drained).toEqual(0);
        processor.complete('a', 'b', 'c');
        await Promise.all(pushed);
        await flushTicks();
        expect(drained).toEqual(1);
        await processQueue.stop();
    });

    test('reports a synchronously thrown processor error to the error handler', async () => {
        const handled: unknown[] = [];
        const completed = async (): Promise<void> => {};
        const processQueue = factory({
            maxProcessing: 1,
            stopOnError: false,
            onError: async ({error, skipCurrentTask}) => {
                handled.push(error);
                skipCurrentTask();
            },
            processor: (task: string) => {
                if (task === 'invalid') {
                    throw new TypeError('task is not valid');
                }

                return completed();
            },
        });
        const uncaught = await withoutProcessErrorHandlers('uncaughtException', async () => {
            processQueue.push('invalid').catch(() => {});
            await flushTicks(20);
        });
        expect(handled).toHaveLength(1);
        expect(uncaught).toEqual([]);
        await processQueue.stop();
    });

    test('keeps processing the remaining tasks when the error handler rejects', async () => {
        const processed: string[] = [];
        const processQueue = factory({
            maxProcessing: 1,
            onError: async ({skipCurrentTask}) => {
                skipCurrentTask();
                throw new Error('the error handler itself failed');
            },
            processor: async (task: string) => {
                processed.push(task);

                if (task === 'a') {
                    throw new Error('cannot process this task');
                }
            },
        });
        const unhandled = await withoutProcessErrorHandlers('unhandledRejection', async () => {
            processQueue.push('a').catch(() => {});
            processQueue.push('b').catch(() => {});
            await flushTicks(20);
        });
        expect(processed).toEqual(['a', 'b']);
        expect(unhandled).toEqual([]);
        await processQueue.stop();
    });

    test('treats an error handler that rejects before skipping the task as one that did not skip it', async () => {
        const processed: string[] = [];
        const failure = new Error('cannot process this task');
        const processQueue = factory({
            maxProcessing: 1,
            onError: async () => {
                throw new Error('the error handler itself failed');
            },
            processor: async (task: string) => {
                processed.push(task);
                throw failure;
            },
        });
        const outcome = processQueue.push('a');
        processQueue.push('b').catch(() => {});
        await expect(outcome).rejects.toBe(failure);
        await flushTicks();
        expect(processed).toEqual(['a']);
        expect(processQueue.isProcessing()).toBe(false);
    });

    test('does not leave an unhandled rejection behind when the error handler rejects', async () => {
        const processQueue = factory({
            maxProcessing: 1,
            onError: async () => {
                throw new Error('the error handler itself failed');
            },
            processor: async () => {
                throw new Error('cannot process this task');
            },
        });
        const unhandled = await withoutProcessErrorHandlers('unhandledRejection', async () => {
            processQueue.push('a').catch(() => {});
            await flushTicks(20);
        });
        expect(unhandled).toEqual([]);
        await processQueue.stop();
    });

    test('keeps processing the remaining tasks when the onFinish hook rejects', async () => {
        const processed: string[] = [];
        const finishFailure = new Error('the finish hook failed');
        const processQueue = factory({
            maxProcessing: 1,
            onError: async () => {},
            onFinish: async (task: string) => {
                if (task === 'a') {
                    throw finishFailure;
                }
            },
            processor: async (task: string) => {
                processed.push(task);
            },
        });
        const first = processQueue.push('a');
        const second = processQueue.push('b');
        await expect(first).rejects.toBe(finishFailure);
        await expect(second).resolves.toEqual('b');
        expect(processed).toEqual(['a', 'b']);
        await processQueue.stop();
    });

    test('does not leave an unhandled rejection behind when the onDrained hook rejects', async () => {
        const processQueue = factory({
            onError: async () => {},
            onDrained: async () => {
                throw new Error('the drained hook failed');
            },
            processor: async () => {},
        });
        const unhandled = await withoutProcessErrorHandlers('unhandledRejection', async () => {
            await processQueue.push('a');
            await processQueue.stop();
            await flushTicks();
        });
        expect(unhandled).toEqual([]);
    });

    test('keeps processing after the onDrained hook rejected', async () => {
        const processed: string[] = [];
        const processQueue = factory({
            // one slot, so a task that never gives its slot back stops the queue
            maxProcessing: 1,
            onError: async () => {},
            onDrained: async () => {
                throw new Error('the drained hook failed');
            },
            processor: async (task: string) => {
                processed.push(task);
            },
        });

        await processQueue.push('a');
        // let the queue drain, which runs the failing onDrained hook, before the next task arrives
        await flushTicks();
        await processQueue.push('b');
        await processQueue.stop();

        expect(processed).toEqual(['a', 'b']);
    });

    test('a task occupies its slot until its onFinish hook has returned', async () => {
        const finishing = Promise.withResolvers<void>();
        const started: string[] = [];
        const processQueue = factory({
            maxProcessing: 1,
            onError: async () => {},
            onFinish: async (task: string) => {
                if (task === 'a') {
                    await finishing.promise;
                }
            },
            processor: async (task: string) => {
                started.push(task);
            },
        });
        const pushed = [processQueue.push('a'), processQueue.push('b')];
        await flushTicks();
        expect(started).toEqual(['a']);
        finishing.resolve();
        await Promise.all(pushed);
        expect(started).toEqual(['a', 'b']);
        await processQueue.stop();
    });

    test('does not resolve stop() while the onFinish hook is still running', async () => {
        const finishing = Promise.withResolvers<void>();
        let finished = false;
        const processQueue = factory({
            onError: async () => {},
            onFinish: async () => {
                await finishing.promise;
                finished = true;
            },
            processor: async () => {},
        });
        processQueue.push('a');
        await flushTicks();
        let stopped = false;
        void processQueue.stop().then(() => (stopped = true));
        await flushTicks();
        expect(stopped).toBe(false);
        finishing.resolve();
        await flushTicks();
        expect(finished).toBe(true);
    });

    test('the onDrained hook can stop the queue without waiting for itself', async () => {
        const stopped = Promise.withResolvers<void>();
        const processQueue: ProcessQueue<string> = factory({
            onError: async () => {},
            onDrained: async queue => {
                await queue.stop();
                stopped.resolve();
            },
            processor: async () => {},
        });
        await processQueue.push('a');
        await stopped.promise;
        expect(processQueue.isProcessing()).toBe(false);
    });

    test('the onError hook can purge the queue without waiting for itself, which leaves its own task queued', async () => {
        const purged = Promise.withResolvers<void>();
        const processed: string[] = [];
        let attempts = 0;
        const processQueue = factory({
            maxProcessing: 1,
            onError: async ({queue}) => {
                await queue.purge();
                purged.resolve();
            },
            processor: async (task: string) => {
                attempts++;

                if (attempts === 1) {
                    throw new Error('cannot process this task yet');
                }

                processed.push(task);
            },
        });
        processQueue.push('a').catch(() => {});
        processQueue.push('b').catch(() => {});
        await purged.promise;
        await flushTicks();
        expect(processQueue.isProcessing()).toBe(false);
        processQueue.start();
        await processQueue.push('c');
        expect(processed).toEqual(['a', 'c']);
        await processQueue.stop();
    });

    test('a hook pushes onto its own queue through the queue it receives', async () => {
        const processed: string[] = [];
        const retried = Promise.withResolvers<void>();
        const processQueue = factory({
            onError: async ({queue, skipCurrentTask}) => {
                skipCurrentTask();
                void queue.push('b').then(() => retried.resolve());
            },
            processor: async (task: string) => {
                if (task === 'a') {
                    throw new Error('try another task');
                }

                processed.push(task);
            },
        });
        processQueue.push('a').catch(() => {});
        await retried.promise;
        expect(processed).toEqual(['b']);
        await processQueue.stop();
    });

    test('the task a queue stopped on is processed again once the queue is started again', async () => {
        const processed: string[] = [];
        let attempts = 0;
        const processQueue = factory({
            maxProcessing: 1,
            onError: async () => {},
            processor: async (task: string) => {
                attempts++;

                if (attempts === 1) {
                    throw new Error('cannot process this task yet');
                }

                processed.push(task);
            },
        });
        const first = processQueue.push('a');
        first.catch(() => {});
        const second = processQueue.push('b');
        await expect(first).rejects.toThrow('cannot process this task yet');
        await flushTicks();
        expect(processQueue.isProcessing()).toBe(false);
        expect(processed).toEqual([]);
        processQueue.start();
        await second;
        expect(processed).toEqual(['a', 'b']);
        await processQueue.stop();
    });

    test('settles the promises of the tasks it purges', async () => {
        const processQueue = factory({
            autoStart: false,
            onError: async () => {},
            processor: async () => {},
        });
        let outcome: unknown = 'pending';
        processQueue.push('a').then(
            () => (outcome = 'completed'),
            reason => (outcome = reason),
        );
        await processQueue.purge();
        await flushTicks();
        expect(outcome).toBeInstanceOf(TaskWasPurged);
    });

    test('purging lets the task in flight finish and rejects the tasks that are waiting', async () => {
        const processor = new GatedProcessor<string>();
        const processQueue = factory({
            maxProcessing: 1,
            onError: async () => {},
            processor: processor.process,
        });
        const inFlight = processQueue.push('a');
        const waiting = processQueue.push('b');
        await flushTicks();
        const purged = processQueue.purge();
        processor.complete('a');
        await purged;
        await expect(inFlight).resolves.toEqual('a');
        await expect(waiting).rejects.toBeInstanceOf(TaskWasPurged);
        expect(processor.started).toEqual(['a']);
    });

    test('purging does not leave an unhandled rejection behind for tasks nobody awaits', async () => {
        const processQueue = factory({
            autoStart: false,
            onError: async () => {},
            processor: async () => {},
        });
        const unhandled = await withoutProcessErrorHandlers('unhandledRejection', async () => {
            void processQueue.push('a');
            await processQueue.purge();
            await flushTicks();
        });
        expect(unhandled).toEqual([]);
    });
});

describe('@deltic/process-queue SequentialProcessQueue', () => {
    test('stopping the queue waits on the current job in progress', async () => {
        const result: string[] = [];
        const processQueue = new SequentialProcessQueue<string>({
            onError: async () => {},
            processor: async (task: string) => {
                result.push(task);
                await wait(5);
                result.push(task);
            },
        });
        processQueue.push('a');
        processQueue.push('b');
        await wait(8);
        await processQueue.stop();
        expect(result).toEqual(['a', 'a', 'b', 'b']);
    });

    test('the queue processes items in order', async () => {
        const waitGroup = new WaitGroup();
        waitGroup.add(3);
        const processor = new AppendingProcessor();
        const processQueue = new SequentialProcessQueue({
            onError: async () => {
                throw new Error('No error handler defined');
            },
            processor: async (task: string) => {
                await processor.process(task);
                waitGroup.done();
            },
        });
        processQueue.push('a');
        processQueue.push('b');
        processQueue.push('c');
        await waitGroup.wait(100);
        expect(processor.value).toEqual('abc');
        await processQueue.stop();
    });

    test('tasks pushed while a task is in flight are processed in push order', async () => {
        const processor = new GatedProcessor<string>();
        const processQueue = new SequentialProcessQueue<string>({
            onError: async () => {},
            processor: processor.process,
        });
        const pushed = [processQueue.push('a')];
        await flushTicks();
        expect(processor.started).toEqual(['a']);
        pushed.push(processQueue.push('b'), processQueue.push('c'));
        await flushTicks();
        expect(processor.started).toEqual(['a']);
        processor.complete('a');
        await flushTicks();
        expect(processor.started).toEqual(['a', 'b']);
        processor.complete('b', 'c');
        await Promise.all(pushed);
        expect(processor.settled).toEqual(['a', 'b', 'c']);
        expect(processor.peakInFlight).toEqual(1);
        await processQueue.stop();
    });

    test('stops processing a failing task when stopOnError is enabled', async () => {
        let attempts = 0;
        const handled = Promise.withResolvers<void>();
        const processQueue = new SequentialProcessQueue<string>({
            stopOnError: true,
            onError: async () => {
                handled.resolve();
            },
            processor: async () => {
                attempts++;
                throw new Error('cannot process this task');
            },
        });
        processQueue.push('a').catch(() => {});
        await handled.promise;
        await flushTicks();
        expect(attempts).toEqual(1);
        expect(processQueue.isProcessing()).toBe(false);
    });

    test('a failing task is retried until the error handler skips it when stopOnError is disabled', async () => {
        let attempts = 0;
        const {promise, resolve} = Promise.withResolvers<void>();
        const processQueue = new SequentialProcessQueue<string>({
            stopOnError: false,
            onError: async ({skipCurrentTask}) => {
                if (attempts >= 3) {
                    skipCurrentTask();
                    resolve();
                }
            },
            processor: async () => {
                attempts++;
                throw new Error('cannot process this task');
            },
        });
        processQueue.push('a').catch(() => {});
        await promise;
        await processQueue.stop();
        expect(attempts).toEqual(3);
    });

    test('processes every task exactly once when it is started again while a task is in flight', async () => {
        const attempts: string[] = [];
        const processor = new GatedProcessor<string>();
        const processQueue = new SequentialProcessQueue<string>({
            onError: async () => {},
            processor: async task => {
                attempts.push(task);

                return processor.process(task);
            },
        });
        processQueue.push('a');
        processQueue.push('b');
        await flushTicks(2);
        expect(attempts).toEqual(['a']);
        void processQueue.stop();
        processQueue.start();
        await flushTicks(4);
        processor.complete('a', 'b');
        await flushTicks(20);
        expect(attempts).toEqual(['a', 'b']);
    });
});

describe('@deltic/process-queue ConcurrentProcessQueue', () => {
    test('the queue processes items in order', async () => {
        const processor = new WaitingProcessor();
        const processQueue = new ConcurrentProcessQueue({
            maxProcessing: 100,
            onError: async () => {
                throw new Error('No error handler defined');
            },
            processor: processor.process,
        });
        processQueue.push(20);
        processQueue.push(15);
        processQueue.push(5);
        await processQueue.push(25);
        expect(processor.values).toHaveLength(4);
        expect(processor.values[0]).toEqual(5);
        expect(processor.values[1]).toEqual(15);
        expect(processor.values[2]).toEqual(20);
        expect(processor.values[3]).toEqual(25);
        await processQueue.stop();
    });

    test('stopping the queue waits for all tasks in progress', async () => {
        const processor = new WaitingProcessor();
        const processQueue = new ConcurrentProcessQueue({
            maxProcessing: 100,
            onError: async () => {
                throw new Error('No error handler defined');
            },
            processor: processor.process,
        });
        processQueue.push(45);
        processQueue.push(55);
        processQueue.push(35);
        await wait(5);
        await processQueue.stop();
        expect(processor.values).toEqual([35, 45, 55]);
    });

    test('never runs more tasks at the same time than maxProcessing allows', async () => {
        const processor = new GatedProcessor<number>();
        const tasks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        const processQueue = new ConcurrentProcessQueue<number>({
            maxProcessing: 3,
            onError: async () => {
                throw new Error('No error handler defined');
            },
            processor: processor.process,
        });
        const pushed = tasks.map(task => processQueue.push(task));
        await flushTicks();
        expect(processor.started).toEqual([1, 2, 3]);
        expect(processor.inFlight).toEqual(3);
        processor.complete(1);
        await flushTicks();
        expect(processor.started).toEqual([1, 2, 3, 4]);
        expect(processor.inFlight).toEqual(3);
        processor.complete(...tasks);
        await Promise.all(pushed);
        expect(processor.settled).toHaveLength(tasks.length);
        expect(processor.peakInFlight).toEqual(3);
        await processQueue.stop();
    });

    test('honours maxProcessing when tasks are pushed in bursts while others are in flight', async () => {
        const processor = new GatedProcessor<number>();
        const processQueue = new ConcurrentProcessQueue<number>({
            maxProcessing: 2,
            onError: async () => {
                throw new Error('No error handler defined');
            },
            processor: processor.process,
        });
        const pushed: Promise<number>[] = [];

        for (let burst = 0; burst < 5; burst++) {
            pushed.push(processQueue.push(burst * 2), processQueue.push(burst * 2 + 1));
            await flushTicks(2);
            expect(processor.inFlight).toBeLessThanOrEqual(2);
        }

        processor.complete(...Array.from({length: 10}, (_value, index) => index));
        await Promise.all(pushed);
        expect(processor.settled).toHaveLength(10);
        expect(processor.peakInFlight).toEqual(2);
        await processQueue.stop();
    });

    test('starts tasks in the order in which they were pushed', async () => {
        const processor = new GatedProcessor<string>();
        const processQueue = new ConcurrentProcessQueue<string>({
            maxProcessing: 2,
            onError: async () => {
                throw new Error('No error handler defined');
            },
            processor: processor.process,
        });
        const pushed = ['a', 'b', 'c', 'd', 'e'].map(task => processQueue.push(task));
        await flushTicks();
        expect(processor.started).toEqual(['a', 'b']);
        processor.complete('b');
        await flushTicks();
        expect(processor.started).toEqual(['a', 'b', 'c']);
        processor.complete('a');
        await flushTicks();
        expect(processor.started).toEqual(['a', 'b', 'c', 'd']);
        processor.complete('c', 'd', 'e');
        await Promise.all(pushed);
        expect(processor.started).toEqual(['a', 'b', 'c', 'd', 'e']);
        await processQueue.stop();
    });

    test('a failing task is retried until the error handler skips it', async () => {
        let attempts = 0;
        const {promise, resolve} = Promise.withResolvers<void>();
        const processQueue = new ConcurrentProcessQueue<string>({
            maxProcessing: 1,
            stopOnError: false,
            onError: async ({skipCurrentTask}) => {
                if (attempts >= 3) {
                    skipCurrentTask();
                    resolve();
                }
            },
            processor: async () => {
                attempts++;
                throw new Error('cannot process this task');
            },
        });
        processQueue.push('a').catch(() => {});
        await promise;
        await processQueue.stop();
        expect(attempts).toEqual(3);
    });

    test('nothing is processed when maxProcessing is zero', async () => {
        let processed = 0;
        let outcome = 'pending';
        const processQueue = new ConcurrentProcessQueue<string>({
            maxProcessing: 0,
            onError: async () => {},
            processor: async () => {
                processed++;
            },
        });
        processQueue.push('a').then(
            () => (outcome = 'completed'),
            () => (outcome = 'rejected'),
        );
        await flushTicks();
        expect(processed).toEqual(0);
        expect(outcome).toEqual('pending');
        await processQueue.stop();
    });

    test('isProcessing() reports whether the queue is started, not whether work is in flight', async () => {
        const processQueue = new ConcurrentProcessQueue<string>({
            onError: async () => {},
            processor: async () => {},
        });
        expect(processQueue.isProcessing()).toBe(true);
        await processQueue.stop();
        expect(processQueue.isProcessing()).toBe(false);
        processQueue.start();
        expect(processQueue.isProcessing()).toBe(true);
        await processQueue.stop();
    });

    test('resumes the tasks that are still queued after stop() and start()', async () => {
        const processed: string[] = [];
        const processQueue = new ConcurrentProcessQueue<string>({
            onError: async () => {},
            processor: async task => {
                processed.push(task);
            },
        });
        processQueue.push('a');
        await processQueue.stop();
        processQueue.start();
        await flushTicks();
        expect(processed).toEqual(['a']);
    });

    test('processes tasks pushed after purge() and start()', async () => {
        const processed: string[] = [];
        const processQueue = new ConcurrentProcessQueue<string>({
            onError: async () => {},
            processor: async task => {
                processed.push(task);
            },
        });
        processQueue.push('before-purge');
        await processQueue.purge();
        processQueue.start();
        processQueue.push('after-purge');
        await flushTicks();
        expect(processed).toEqual(['after-purge']);
    });

    test('resolves stop() after the queue stopped itself because a task failed', async () => {
        const processor = new GatedProcessor<string>();
        const processQueue = new ConcurrentProcessQueue<string>({
            maxProcessing: 2,
            onError: async () => {},
            processor: processor.process,
        });
        processQueue.push('failing').catch(() => {});
        processQueue.push('slow');
        await flushTicks();
        processor.fail('failing', new Error('cannot process this task'));
        await flushTicks();
        expect(processQueue.isProcessing()).toBe(false);
        let stopped = false;
        void processQueue.stop().then(() => (stopped = true));
        processor.complete('slow');
        await flushTicks(20);
        expect(stopped).toBe(true);
    });

    test('resolves stop() when the error handler awaits it while another task is in flight', async () => {
        const processor = new GatedProcessor<string>();
        let stopped = false;
        const processQueue = new ConcurrentProcessQueue<string>({
            maxProcessing: 2,
            onError: async ({queue}) => {
                await queue.stop();
                stopped = true;
            },
            processor: processor.process,
        });
        processQueue.push('failing').catch(() => {});
        processQueue.push('slow');
        await flushTicks();
        processor.fail('failing', new Error('cannot process this task'));
        await flushTicks();
        processor.complete('slow');
        await flushTicks(20);
        expect(stopped).toBe(true);
    });

    test('resolves stop() when several error handlers await it at the same time', async () => {
        const processor = new GatedProcessor<string>();
        const stopped: string[] = [];
        const processQueue = new ConcurrentProcessQueue<string>({
            maxProcessing: 2,
            onError: async ({queue, task}) => {
                await queue.stop();
                stopped.push(task);
            },
            processor: processor.process,
        });
        processQueue.push('first').catch(() => {});
        processQueue.push('second').catch(() => {});
        await flushTicks();
        processor.fail('first', new Error('cannot process this task'));
        processor.fail('second', new Error('cannot process this task'));
        await flushTicks(20);
        expect(stopped.toSorted()).toEqual(['first', 'second']);
        await expect(processQueue.stop()).resolves.toBeUndefined();
    });

});

describe('@deltic/process-queue PartitionedProcessQueue', () => {
    type PartitionedTask = {key: number; id: string};

    const partitionedQueue = (
        processor: GatedProcessor<string>,
        numberOfPartitions: number,
        partitions: ProcessQueue<PartitionedTask>[] = [],
    ) =>
        new PartitionedProcessQueue<PartitionedTask>(
            () => {
                const partition = new SequentialProcessQueue<PartitionedTask>({
                    onError: async ({skipCurrentTask}) => {
                        skipCurrentTask();
                    },
                    processor: task => processor.process(task.id),
                });
                partitions.push(partition);

                return partition;
            },
            task => task.key,
            numberOfPartitions,
        );

    test('a queue is created for every partition', async () => {
        const partitions: ProcessQueue<PartitionedTask>[] = [];
        const processQueue = partitionedQueue(new GatedProcessor<string>(), 4, partitions);
        expect(partitions).toHaveLength(4);
        await processQueue.stop();
    });

    test('tasks that share a partition key are processed one at a time in push order', async () => {
        const processor = new GatedProcessor<string>();
        const processQueue = partitionedQueue(processor, 4);
        const pushed = ['a', 'b', 'c'].map(id => processQueue.push({key: 2, id}));
        await flushTicks();
        expect(processor.started).toEqual(['a']);
        processor.complete('a');
        await flushTicks();
        expect(processor.started).toEqual(['a', 'b']);
        processor.complete('b', 'c');
        await Promise.all(pushed);
        expect(processor.settled).toEqual(['a', 'b', 'c']);
        expect(processor.peakInFlight).toEqual(1);
        await processQueue.stop();
    });

    test('tasks with different partition keys are processed concurrently', async () => {
        const processor = new GatedProcessor<string>();
        const processQueue = partitionedQueue(processor, 4);
        const pushed = [
            processQueue.push({key: 0, id: 'first'}),
            processQueue.push({key: 1, id: 'second'}),
        ];
        await flushTicks();
        expect(processor.started).toEqual(['first', 'second']);
        expect(processor.inFlight).toEqual(2);
        processor.complete('first', 'second');
        await Promise.all(pushed);
        expect(processor.peakInFlight).toEqual(2);
        await processQueue.stop();
    });

    test('partition keys are mapped onto the available partitions', async () => {
        const processor = new GatedProcessor<string>();
        const processQueue = partitionedQueue(processor, 4);
        const pushed = [
            processQueue.push({key: 2, id: 'low'}),
            processQueue.push({key: 6, id: 'wrapped-around'}),
        ];
        await flushTicks();
        expect(processor.started).toEqual(['low']);
        processor.complete('low');
        await flushTicks();
        expect(processor.started).toEqual(['low', 'wrapped-around']);
        processor.complete('wrapped-around');
        await Promise.all(pushed);
        expect(processor.peakInFlight).toEqual(1);
        await processQueue.stop();
    });

    test('the error handler receives the partition that failed, not the partitioned queue', async () => {
        const partitions: ProcessQueue<PartitionedTask>[] = [];
        const {promise, resolve} = Promise.withResolvers<void>();
        const processQueue = new PartitionedProcessQueue<PartitionedTask>(
            () => {
                const partition = new SequentialProcessQueue<PartitionedTask>({
                    onError: async ({queue, skipCurrentTask}) => {
                        skipCurrentTask();
                        void queue.stop();
                        resolve();
                    },
                    processor: async () => {
                        throw new Error('cannot process this task');
                    },
                });
                partitions.push(partition);

                return partition;
            },
            task => task.key,
            2,
        );
        processQueue.push({key: 1, id: 'a'}).catch(() => {});
        await promise;
        expect(partitions.map(partition => partition.isProcessing())).toEqual([true, false]);
        await processQueue.stop();
    });

    test('isProcessing() reflects whether the partitions are started', async () => {
        const processQueue = partitionedQueue(new GatedProcessor<string>(), 3);
        expect(processQueue.isProcessing()).toBe(true);
        await processQueue.stop();
        expect(processQueue.isProcessing()).toBe(false);
        processQueue.start();
        expect(processQueue.isProcessing()).toBe(true);
        await processQueue.stop();
    });

});

class WaitingProcessor {
    public values: number[] = [];

    constructor() {
        this.process = this.process.bind(this);
    }

    public async process(value: number): Promise<void> {
        await wait(value);
        this.values.push(value);
    }
}

const wait = (duration: number) => new Promise(resolve => setTimeout(resolve, duration));

const immediate = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * The queues schedule their work with setImmediate, so draining a fixed number of
 * immediate turns advances them deterministically without relying on the clock.
 */
const flushTicks = async (turns: number = 12): Promise<void> => {
    for (let turn = 0; turn < turns; turn++) {
        await immediate();
    }
};

type ProcessErrorEvent = 'unhandledRejection' | 'uncaughtException';
type ProcessErrorListener = (...args: unknown[]) => void;

/**
 * Collects the process level errors raised while running the given block instead of
 * letting the test runner report them, and returns everything that was captured.
 */
const withoutProcessErrorHandlers = async (
    event: ProcessErrorEvent,
    run: () => Promise<void>,
): Promise<unknown[]> => {
    const captured: unknown[] = [];
    const registered = process.listeners(event) as ProcessErrorListener[];
    process.removeAllListeners(event);
    process.on(event as string, (reason: unknown) => {
        captured.push(reason);
    });

    try {
        await run();
    } finally {
        process.removeAllListeners(event);

        for (const listener of registered) {
            process.on(event as string, listener);
        }
    }

    return captured;
};

/**
 * A processor that only completes a task once the test releases it, so that the
 * moment at which a task settles is fully controlled by the test.
 */
class GatedProcessor<Task> {
    public readonly started: Task[] = [];
    public readonly settled: Task[] = [];
    private readonly gates: Map<Task, PromiseWithResolvers<void>> = new Map();
    private highWaterMark: number = 0;

    constructor() {
        this.process = this.process.bind(this);
    }

    public async process(task: Task): Promise<void> {
        this.started.push(task);
        this.highWaterMark = Math.max(this.highWaterMark, this.inFlight);

        try {
            await this.gate(task).promise;
        } finally {
            this.settled.push(task);
        }
    }

    public get inFlight(): number {
        return this.started.length - this.settled.length;
    }

    public get peakInFlight(): number {
        return this.highWaterMark;
    }

    public complete(...tasks: Task[]): void {
        for (const task of tasks) {
            this.gate(task).resolve();
        }
    }

    public fail(task: Task, error: Error): void {
        const gate = this.gate(task);
        gate.promise.catch(() => {});
        gate.reject(error);
    }

    private gate(task: Task): PromiseWithResolvers<void> {
        let gate = this.gates.get(task);

        if (gate === undefined) {
            gate = Promise.withResolvers<void>();
            this.gates.set(task, gate);
        }

        return gate;
    }
}

class AppendingProcessor {
    public value: string = '';

    constructor() {
        this.process = this.process.bind(this);
    }

    public async process(value: string): Promise<void> {
        this.value = this.value.concat(value);
    }
}
