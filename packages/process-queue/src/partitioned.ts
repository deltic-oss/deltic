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
        // `%` keeps the sign of the key; adding the number of partitions maps negative keys into range,
        // while a non-negative key keeps the partition it always had.
        const key = Math.trunc(this.partitioner(task));
        const partition = ((key % this.numberOfPartitions) + this.numberOfPartitions) % this.numberOfPartitions;

        return this.queues.get(partition)!.push(task);
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
