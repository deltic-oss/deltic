import {type ProcessQueue, ProcessQueueDefaults, type ProcessQueueOptions} from './api.js';

interface QueuedTask<Task> {
    readonly task: Task;
    readonly promise: Promise<Task>;
    readonly resolve: (task: Task) => void;
    readonly reject: (reason: unknown) => void;
}

/**
 * Processes up to `maxProcessing` tasks at the same time, starting them in push order.
 *
 * A task is in flight from the moment its processor is called until its `onFinish` or `onError`
 * hook, and the `onDrained` hook its completion triggers, have returned. It occupies one of the
 * `maxProcessing` slots for that whole time, and `stop()` waits for it.
 */
export class ConcurrentProcessQueue<Task> implements ProcessQueue<Task> {
    private readonly config: Required<ProcessQueueOptions<Task>>;
    private backlog: QueuedTask<Task>[] = [];
    private readonly inFlight: Map<QueuedTask<Task>, Promise<void>> = new Map();
    private started: boolean;
    private scheduled: ReturnType<typeof setImmediate> | undefined = undefined;

    /**
     * The queue as `onError` and `onDrained` receive it. Those hooks run while their own task is in
     * flight, so `stop()` and `purge()` on it stop the queue without waiting for the work in flight.
     * Awaiting a stop through any other reference from inside the queue waits for the caller's own
     * task, and never resolves.
     */
    private readonly handle: ProcessQueue<Task> = {
        isProcessing: () => this.isProcessing(),
        start: () => this.start(),
        push: task => this.push(task),
        stop: async () => this.halt(),
        purge: async () => {
            this.halt();
            this.dropWaitingTasks();
        },
    };

    constructor(options: ProcessQueueOptions<Task>) {
        this.config = {...ProcessQueueDefaults, ...options};
        this.started = this.config.autoStart;
        this.processNextTask = this.processNextTask.bind(this);
    }

    isProcessing(): boolean {
        return this.started;
    }

    start(): void {
        if (this.started) {
            return;
        }

        this.started = true;
        this.schedule();
    }

    push(task: Task): Promise<Task> {
        const {promise, resolve, reject} = Promise.withResolvers<Task>();
        this.backlog.push({task, promise, resolve, reject});
        this.schedule();

        return promise;
    }

    async stop(): Promise<void> {
        this.halt();
        await Promise.all(this.inFlight.values());
    }

    /**
     * Stops the queue and drops the tasks that are waiting.
     */
    async purge(): Promise<void> {
        await this.stop();
        this.dropWaitingTasks();
    }

    private dropWaitingTasks(): void {
        this.backlog = this.backlog.filter(item => this.inFlight.has(item));
    }

    private halt(): void {
        this.started = false;

        if (this.scheduled !== undefined) {
            clearImmediate(this.scheduled);
            this.scheduled = undefined;
        }
    }

    private schedule(): void {
        if (
            this.started &&
            this.scheduled === undefined &&
            this.inFlight.size < this.config.maxProcessing &&
            this.nextWaitingTask() !== undefined
        ) {
            this.scheduled = setImmediate(this.processNextTask);
        }
    }

    private nextWaitingTask(): QueuedTask<Task> | undefined {
        return this.backlog.find(item => !this.inFlight.has(item));
    }

    private processNextTask(): void {
        this.scheduled = undefined;

        if (!this.started || this.inFlight.size >= this.config.maxProcessing) {
            return;
        }

        const next = this.nextWaitingTask();

        if (next === undefined) {
            return;
        }

        const {promise, resolve} = Promise.withResolvers<void>();
        this.inFlight.set(next, promise);
        void this.process(next).then(resolve, resolve);
        this.schedule();
    }

    private async process(item: QueuedTask<Task>): Promise<void> {
        try {
            try {
                // Inside the async function, a processor that throws instead of rejecting ends up here too.
                await this.config.processor(item.task);
            } catch (error) {
                await this.handleFailure(item, error);

                return;
            }

            await this.handleSuccess(item);
        } finally {
            if (this.backlog.length === 0) {
                await this.config.onDrained(this.handle);
            }

            this.inFlight.delete(item);
            this.schedule();
        }
    }

    private async handleSuccess(item: QueuedTask<Task>): Promise<void> {
        this.remove(item);

        await this.config.onFinish(item.task);
        item.resolve(item.task);
    }

    private async handleFailure(item: QueuedTask<Task>, error: unknown): Promise<void> {
        let skipped = false;
        const skipCurrentTask = (): void => {
            if (skipped) {
                return;
            }

            skipped = true;
            item.promise.catch(() => {});
            this.remove(item);
        };

        await this.config.onError({error, task: item.task, queue: this.handle, skipCurrentTask});

        item.reject(error);

        if (!skipped && this.config.stopOnError) {
            this.halt();
        }
    }

    private remove(item: QueuedTask<Task>): void {
        const index = this.backlog.indexOf(item);

        if (index >= 0) {
            this.backlog.splice(index, 1);
        }
    }
}
