import {type ProcessQueue, ProcessQueueDefaults, type ProcessQueueOptions} from './api.js';
import {type ProcessStackItem, rejectPurgedTasks} from './internals.js';
import {WaitGroup} from '@deltic/wait-group';

export class ConcurrentProcessQueue<Task> implements ProcessQueue<Task> {
    private stack: ProcessStackItem<Task>[] = [];
    private running: boolean = true;
    private processing: number = 0;
    private timer: ReturnType<typeof setImmediate> | undefined = undefined;
    private config: Required<ProcessQueueOptions<Task>>;
    private maxProcessing: number;
    private waitGroup: WaitGroup = new WaitGroup();

    public constructor(options: ProcessQueueOptions<Task>) {
        this.config = {...ProcessQueueDefaults, ...options};
        this.processNextTask = this.processNextTask.bind(this);
        this.skipCurrentTask = this.skipCurrentTask.bind(this);
        this.running = this.config.autoStart;
        this.maxProcessing = this.config.maxProcessing;
    }

    isProcessing(): boolean {
        return this.running;
    }

    public async purge() {
        await this.stop();
        const purged = this.stack.filter(item => item.processing !== true);
        this.stack = [];
        rejectPurgedTasks(purged);
        this.config.onStop(this);
    }

    public start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.scheduleNextTask();
    }

    private scheduleNextTask(): void {
        /* istanbul ignore else  */
        if (this.running && this.timer === undefined && this.processing < this.maxProcessing) {
            this.timer = setImmediate(this.processNextTask);
        }
    }

    private skipCurrentTask(item: ProcessStackItem<Task>): void {
        item.promise.catch(() => {});
        this.stack = this.stack.filter(i => i !== item);
    }

    private processNextTask(): void {
        this.timer = undefined;
        const next = this.stack.find(i => i.processing !== true);
        /* istanbul ignore else  */
        if (next !== undefined) {
            this.waitGroup.add();
            next.processing = true;
            this.processing++;
            const promise = this.config.processor.apply(null, [next.task]);
            promise
                .then(() => {
                    this.handleProcessorResult(undefined, next as ProcessStackItem<Task>);
                })
                .catch((err: Error) => {
                    this.handleProcessorResult(err, next as ProcessStackItem<Task>);
                });

            this.scheduleNextTask();
        }
    }

    public push(task: Task): Promise<Task> {
        const {reject, resolve, promise} = Promise.withResolvers<Task>();
        this.stack.push({task, promise, reject, resolve});

        if (this.stack.length === 1 && this.running) {
            this.scheduleNextTask();
        }

        return promise;
    }

    private async handleProcessorResult(err: Error | undefined, item: ProcessStackItem<Task>): Promise<void> {
        this.processing--;
        item.processing = false;
        const {task, resolve, reject} = item;

        if (err) {
            let skipped = false;

            await this.config.onError({
                error: err,
                task,
                queue: this,
                skipCurrentTask: () => {
                    this.skipCurrentTask(item);
                    skipped = true;
                },
            });
            reject(err);

            if (skipped === false && this.config.stopOnError) {
                return this.stop();
            }
        } else {
            this.stack = this.stack.filter(i => i !== item);
            await this.config.onFinish.apply(null, [task]);
            resolve(task);
        }

        if (this.stack.length === 0) {
            await this.config.onDrained.apply(null, [this]);
        } else if (this.running) {
            this.scheduleNextTask();
        }

        this.waitGroup.done();
    }

    public stop(): Promise<void> {
        this.running = false;
        clearImmediate(this.timer);

        if (this.processing === 0) {
            return Promise.resolve();
        }

        return this.waitGroup.wait();
    }
}
