import {type ProcessQueue} from './api.js';

type processQueueFactory<T> = () => ProcessQueue<T>;
type partitioner<T> = (task: T) => number;

export class PartitionedProcessQueue<Task> implements ProcessQueue<Task> {
    private readonly queues: Map<number, ProcessQueue<Task>> = new Map();
    constructor(
        factory: processQueueFactory<Task>,
        readonly partitioner: partitioner<Task>,
        readonly numberOfPartitions: number,
        private readonly onStop: (queue: ProcessQueue<Task>) => any = () => {},
    ) {
        for (let i = 0; i < numberOfPartitions; i++) {
            this.queues.set(i, factory());
        }
    }

    isProcessing(): boolean {
        return Array.from(this.queues.values()).some(queue => queue.isProcessing());
    }

    async purge(): Promise<void> {
        const wasProcessing = this.isProcessing();
        const p: Promise<void>[] = [];
        for (const queue of this.queues.values()) {
            p.push(queue.purge());
        }

        await Promise.all(p);
        await this.notifyStopped(wasProcessing);
    }

    push(task: Task): Promise<Task> {
        return this.queues.get(this.partitioner(task) % this.numberOfPartitions)!.push(task);
    }

    start(): void {
        for (const queue of this.queues.values()) {
            queue.start();
        }
    }

    async stop(): Promise<void> {
        const wasProcessing = this.isProcessing();
        const p: Promise<void>[] = [];
        for (const queue of this.queues.values()) {
            p.push(queue.stop());
        }

        await Promise.all(p);
        await this.notifyStopped(wasProcessing);
    }

    /**
     * Like the partitions themselves, the queue reports coming to a stop once, and a failing
     * callback does not fail the stop.
     */
    private async notifyStopped(wasProcessing: boolean): Promise<void> {
        if (!wasProcessing) {
            return;
        }

        try {
            await this.onStop(this);
        } catch {
            // The callback's failure is the consumer's to handle inside the callback.
        }
    }
}
