import type {ProcessQueue, ProcessQueueOptions} from './api.js';
import {ProcessQueueRunner} from './internals.js';

/**
 * Processes one task at a time, in push order. `maxProcessing` does not apply.
 */
export class SequentialProcessQueue<Task> implements ProcessQueue<Task> {
    private readonly runner: ProcessQueueRunner<Task>;

    public constructor(options: ProcessQueueOptions<Task>) {
        this.runner = new ProcessQueueRunner<Task>(this, {...options, maxProcessing: 1});
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
