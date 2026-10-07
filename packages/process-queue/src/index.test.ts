import {
    ConcurrentProcessQueue,
    PartitionedProcessQueue,
    type ProcessQueue,
    type ProcessQueueOptions,
    SequentialProcessQueue,
} from './index.js';
import {WaitGroup} from '@deltic/wait-group';

type Factory = <T>(options: ProcessQueueOptions<T>) => ProcessQueue<T>;

const createSequentialProcessor = <T>(options: ProcessQueueOptions<T>): ProcessQueue<T> =>
    new SequentialProcessQueue<T>(options);

const createConcurrentProcessor = <T>(options: ProcessQueueOptions<T>): ProcessQueue<T> =>
    new ConcurrentProcessQueue<T>(options);

const createPartitionedProcessor = <T>(options: ProcessQueueOptions<T>): ProcessQueue<T> => {
    const {onStop, ...rest} = options;

    return new PartitionedProcessQueue<T>(
        () => new SequentialProcessQueue<T>(rest),
        () => 0,
        1,
        onStop,
    );
};

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

    test('the onStop hook is called when the queue is stopped and when it is purged', async () => {
        let stopped = 0;
        const processQueue = new SequentialProcessQueue<string>({
            onError: async () => {},
            onStop: () => {
                stopped++;
            },
            processor: async () => {},
        });
        await processQueue.stop();
        expect(stopped).toEqual(1);
        await processQueue.purge();
        expect(stopped).toEqual(2);
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

});

describe('@deltic/process-queue PartitionedProcessQueue', () => {
    type PartitionedTask = {key: number; id: string};

    const partitionedQueue = (
        processor: GatedProcessor<string>,
        numberOfPartitions: number,
        onStop?: (queue: ProcessQueue<PartitionedTask>) => void,
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
            onStop,
        );

    test('a queue is created for every partition', async () => {
        const partitions: ProcessQueue<PartitionedTask>[] = [];
        const processQueue = partitionedQueue(new GatedProcessor<string>(), 4, undefined, partitions);
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
        let received: ProcessQueue<PartitionedTask> | undefined = undefined;
        const processQueue = new PartitionedProcessQueue<PartitionedTask>(
            () => {
                const partition = new SequentialProcessQueue<PartitionedTask>({
                    onError: async ({queue, skipCurrentTask}) => {
                        received = queue;
                        skipCurrentTask();
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
        expect(received).toBe(partitions[1]);
        expect(received).not.toBe(processQueue);
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

    test('the onStop hook is called when the queue is stopped', async () => {
        let stopped = 0;
        const processQueue = partitionedQueue(new GatedProcessor<string>(), 2, () => {
            stopped++;
        });
        await processQueue.stop();
        expect(stopped).toEqual(1);
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
