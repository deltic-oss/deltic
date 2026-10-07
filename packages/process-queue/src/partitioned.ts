import {type ProcessQueue} from './api.js';

type processQueueFactory<T> = () => ProcessQueue<T>;
type partitioner<T> = (task: T) => number;

export class PartitionedProcessQueue<Task> implements ProcessQueue<Task> {
    private readonly queues: Map<number, ProcessQueue<Task>> = new Map();
    constructor(
        factory: processQueueFactory<Task>,
        readonly partitioner: partitioner<Task>,
        readonly numberOfPartitions: number,
    ) {
        for (let i = 0; i < numberOfPartitions; i++) {
            this.queues.set(i, factory());
        }
    }

    isProcessing(): boolean {
        return Array.from(this.queues.values()).some(queue => queue.isProcessing());
    }

    async purge(): Promise<void> {
        const p: Promise<void>[] = [];
        for (const queue of this.queues.values()) {
            p.push(queue.purge());
        }

        await Promise.all(p);
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
        const p: Promise<void>[] = [];
        for (const queue of this.queues.values()) {
            p.push(queue.stop());
        }

        await Promise.all(p);
    }
}
