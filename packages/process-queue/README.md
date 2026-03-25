# @deltic/process-queue

Process queue implementations for concurrent, sequential, and partitioned task execution.

## Installation

```bash
npm install @deltic/process-queue
```

## Usage

### Concurrent Processing

```typescript
import {ConcurrentProcessQueue} from '@deltic/process-queue';

const queue = new ConcurrentProcessQueue<Job>({
    processor: async (job) => {
        await processJob(job);
    },
    onError: async ({error, task, skipCurrentTask}) => {
        console.error('Failed to process job', error);
        skipCurrentTask(); // skip and continue
    },
    maxProcessing: 10,
});

await queue.push(job);
```

### Sequential Processing

```typescript
import {SequentialProcessQueue} from '@deltic/process-queue';

const queue = new SequentialProcessQueue<Job>({
    processor: async (job) => {
        await processJob(job);
    },
    onError: async ({error}) => {
        console.error(error);
    },
});
```

### Partitioned Processing

Distribute tasks across multiple queues based on a partition key:

```typescript
import {PartitionedProcessQueue, ConcurrentProcessQueue} from '@deltic/process-queue';

const queue = new PartitionedProcessQueue<Job>(
    () => new ConcurrentProcessQueue({processor, onError}), // factory
    (job) => hashCode(job.tenantId),                         // partitioner
    4,                                                       // number of partitions
);

await queue.push(job); // routed to partition based on tenantId
```

### Lifecycle Callbacks

```typescript
const queue = new ConcurrentProcessQueue<Job>({
    processor: async (job) => { /* ... */ },
    onError: async ({error, skipCurrentTask, queue}) => {
        skipCurrentTask();
    },
    onFinish: async (job) => {
        console.log('Job completed', job);
    },
    onDrained: async (queue) => {
        console.log('Queue drained');
    },
    onStop: (queue) => {
        console.log('Queue stopped');
    },
    stopOnError: false,  // default: true
    autoStart: true,     // default: true
    maxProcessing: 100,  // default: 100
});
```

### Manual Control

```typescript
const queue = new ConcurrentProcessQueue<Job>({
    processor,
    onError,
    autoStart: false,
});

queue.start();
await queue.push(job);
await queue.stop();  // waits for in-flight tasks
await queue.purge(); // clears pending tasks
```

## API Reference

### `ProcessQueue<Task>` (interface)

| Method | Description |
|--------|-------------|
| `push(task)` | Adds a task to the queue |
| `start()` | Starts processing |
| `stop()` | Stops processing, waits for in-flight tasks |
| `purge()` | Clears all pending tasks |
| `isProcessing()` | Returns `true` if tasks are being processed |

### `ProcessQueueOptions<Task>`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `processor` | `(task) => Promise<any>` | required | Task processing function |
| `onError` | `(context) => Promise<any>` | required | Error handler |
| `maxProcessing` | `number` | `100` | Max concurrent tasks |
| `autoStart` | `boolean` | `true` | Start processing on construction |
| `stopOnError` | `boolean` | `true` | Stop the queue on error |
| `onDrained` | `(queue) => Promise<any>` | — | Called when queue is empty |
| `onFinish` | `(task) => Promise<any>` | — | Called after each task completes |
| `onStop` | `(queue) => any` | — | Called when queue stops |

## License

ISC
