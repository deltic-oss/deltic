import {AsyncLocalStorage} from 'node:async_hooks';
import {type ProcessQueue, ProcessQueueDefaults, type ProcessQueueOptions, TaskWasPurged} from './api.js';

/**
 * Holds the runner whose callback (processor or hook) is running. A callback cannot wait for the
 * work in flight, because its own task is part of that work, so `stop()` needs to tell a call from
 * inside the queue apart from one made from the outside.
 */
const callbackScope = new AsyncLocalStorage<object>();

export interface QueuedTask<Task> {
    readonly task: Task;
    readonly promise: Promise<Task>;
    readonly resolve: (task: Task) => void;
    readonly reject: (reason: unknown) => void;
}

/**
 * The scheduling and lifecycle shared by the queue implementations. A sequential queue is a runner
 * that processes one task at a time; a concurrent queue is one that processes up to `maxProcessing`.
 *
 * A task is in flight from the moment its processor is called until its `onFinish` or `onError`
 * hook, and the `onDrained` or `onStop` callback its completion triggers, have returned. It
 * occupies one of the `maxProcessing` slots for that whole time, and `stop()` waits for it.
 */
export class ProcessQueueRunner<Task> {
    private readonly config: Required<ProcessQueueOptions<Task>>;
    private backlog: QueuedTask<Task>[] = [];
    private readonly inFlight: Map<QueuedTask<Task>, Promise<void>> = new Map();
    private started: boolean;
    private scheduled: ReturnType<typeof setImmediate> | undefined = undefined;
    private stopNotificationPending: boolean = false;

    constructor(
        private readonly queue: ProcessQueue<Task>,
        options: ProcessQueueOptions<Task>,
    ) {
        this.config = {...ProcessQueueDefaults, ...options};
        this.started = this.config.autoStart;
        this.processNextTask = this.processNextTask.bind(this);
    }

    isStarted(): boolean {
        return this.started;
    }

    start(): void {
        if (this.started) {
            return;
        }

        this.started = true;
        // A queue restarted before it came to rest never stopped, so there is nothing to report.
        this.stopNotificationPending = false;
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

        if (callbackScope.getStore() === this) {
            // The task this call is made from completes after it, and reports the stop then.
            return;
        }

        await Promise.all(this.inFlight.values());
        await this.notifyStopped();
    }

    /**
     * Stops the queue and drops the tasks that are waiting, rejecting them with `TaskWasPurged`.
     */
    async purge(): Promise<void> {
        await this.stop();
        const purged = this.backlog.filter(item => !this.inFlight.has(item));
        this.backlog = this.backlog.filter(item => this.inFlight.has(item));

        for (const item of purged) {
            // Like a skipped task, a purged one must not become an unhandled rejection for a caller that
            // let go of its promise; a caller that awaits it still sees the rejection.
            item.promise.catch(() => {});
            item.reject(TaskWasPurged.beforeItWasProcessed());
        }
    }

    private halt(): void {
        if (this.started) {
            this.started = false;
            this.stopNotificationPending = true;
        }

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
                await this.inCallbackScope(() => this.config.processor(item.task));
            } catch (error) {
                await this.handleFailure(item, error);

                return;
            }

            await this.handleSuccess(item);
        } finally {
            if (this.backlog.length === 0) {
                await this.runCallback(() => this.config.onDrained(this.queue));
            }

            this.inFlight.delete(item);
            this.schedule();
            await this.notifyStopped();
        }
    }

    private async handleSuccess(item: QueuedTask<Task>): Promise<void> {
        this.remove(item);

        try {
            await this.inCallbackScope(() => this.config.onFinish(item.task));
        } catch (error) {
            item.reject(error);

            return;
        }

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

        try {
            await this.inCallbackScope(() =>
                this.config.onError({error, task: item.task, queue: this.queue, skipCurrentTask}),
            );
        } catch {
            // An error handler that fails has not dealt with the task, so the task is treated as not skipped.
        }

        item.reject(error);

        if (!skipped && this.config.stopOnError) {
            this.halt();
        }
    }

    private async notifyStopped(): Promise<void> {
        if (!this.stopNotificationPending || this.started || this.inFlight.size > 0) {
            return;
        }

        this.stopNotificationPending = false;
        await this.runCallback(() => this.config.onStop(this.queue));
    }

    private remove(item: QueuedTask<Task>): void {
        const index = this.backlog.indexOf(item);

        if (index >= 0) {
            this.backlog.splice(index, 1);
        }
    }

    private inCallbackScope<R>(callback: () => R): R {
        return callbackScope.run(this, callback);
    }

    /**
     * Runs a notification callback, whose failure must neither stop the queue's bookkeeping nor
     * surface as an unhandled rejection.
     */
    private async runCallback(callback: () => unknown): Promise<void> {
        try {
            await this.inCallbackScope(callback);
        } catch {
            // The callback's failure is the consumer's to handle inside the callback.
        }
    }
}
