export interface Processor<Task> {
    (task: Task): Promise<any>;
}

export interface ProcessQueue<Task> {
    isProcessing(): boolean;
    purge(): Promise<void>;
    start(): void;
    push(task: Task): Promise<Task>;
    stop(): Promise<void>;
}

export type ErrorContext<Task> = {
    error: unknown;
    task: Task;
    skipCurrentTask(): void;
    queue: ProcessQueue<Task>;
};

export interface ProcessQueueOptions<Task> {
    maxProcessing?: number;
    processor: Processor<Task>;
    autoStart?: boolean;
    onDrained?(queue: ProcessQueue<Task>): Promise<any>;
    onError(config: ErrorContext<Task>): Promise<any>;
    stopOnError?: boolean;
    onFinish?(task: Task): Promise<any>;
}

export const ProcessQueueDefaults = Object.seal({
    maxProcessing: 100,
    stopOnError: true,
    autoStart: true,
    onDrained: async () => {},
    onFinish: async () => {},
});
