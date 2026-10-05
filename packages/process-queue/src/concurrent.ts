import type {ProcessQueue, ProcessQueueOptions} from './api.js';
import {ProcessQueueRunner} from './internals.js';

/**
 * Processes up to `maxProcessing` tasks at the same time, starting them in push order.
 */
export class ConcurrentProcessQueue<Task> implements ProcessQueue<Task> {
    private readonly runner: ProcessQueueRunner<Task>;

    public constructor(options: ProcessQueueOptions<Task>) {
        this.runner = new ProcessQueueRunner<Task>(this, options);
    }

    isProcessing(): boolean {
        return this.runner.isStarted();
    }

    public purge(): Promise<void> {
        return this.runner.purge();
    }

    public start(): void {
        this.runner.start();
    }

    public push(task: Task): Promise<Task> {
        return this.runner.push(task);
    }

    public stop(): Promise<void> {
        return this.runner.stop();
    }
}
