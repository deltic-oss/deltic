import {TaskWasPurged} from './api.js';

export interface ResolveFunc<T> {
    (t: T | PromiseLike<T>): void;
}

export interface RejectFunc {
    (reason?: any): void;
}

export interface ProcessStackItem<Task> {
    processing?: boolean;
    partitionKey?: string;
    promise: Promise<Task>;
    task: Task;
    resolve: ResolveFunc<Task>;
    reject: RejectFunc;
}

export function rejectPurgedTasks<Task>(items: ProcessStackItem<Task>[]): void {
    for (const item of items) {
        // Like a skipped task, a purged one must not become an unhandled rejection for a caller that
        // let go of its promise; a caller that awaits it still sees the rejection.
        item.promise.catch(() => {});
        item.reject(TaskWasPurged.beforeItWasProcessed());
    }
}
