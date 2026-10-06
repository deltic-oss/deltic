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
    onError: async ({error, skipCurrentTask}) => {
        console.error(error);
        skipCurrentTask(); // without this, the queue stops on the failed task (see "Failed Tasks")
    },
});
```

A sequential queue processes one task at a time, in push order; `maxProcessing` does not apply.

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
await queue.purge(); // drops pending tasks, rejecting them with TaskWasPurged
```

## Lifecycle

- **In flight.** A task is in flight from the moment its processor is called until its `onFinish` or
  `onError` hook — and the `onDrained` or `onStop` callback its completion triggers — has returned. It
  occupies one of the `maxProcessing` slots for that whole time.
- **`stop()`** stops starting new tasks and resolves once the tasks in flight have finished, hooks
  included. The tasks that are waiting stay queued: `start()` picks them up again, and tasks pushed
  while the queue is stopped are processed once it is started. Calling `start()` before a `stop()`
  has resolved resumes the queue; a task already in flight is never started a second time.
- **Stopping from inside the queue.** A processor or hook may call `stop()` on its own queue (for
  example `await queue.stop()` in `onError`). That call stops the queue without waiting for the work
  in flight — it cannot, since its own task is part of that work. A `stop()` called from anywhere else
  always waits.
- **`purge()`** stops the queue the same way and drops the tasks that are waiting. Their `push()`
  promises reject with `TaskWasPurged`.
- **`onStop`** is called once each time the queue comes to a stop — through `stop()`, `purge()`, or
  `stopOnError` — after the work in flight has finished. Stopping a queue that is already stopped, or
  one that was never started, does not call it again. For a `PartitionedProcessQueue`, its own `onStop`
  (the fourth constructor argument) follows the same rule for the partitioned queue as a whole.

### Failed Tasks

When the processor rejects or throws, the task's `push()` promise rejects with that error and
`onError` is called. Then:

- if `onError` called `skipCurrentTask()`, the task is dropped and the queue moves on;
- otherwise, with `stopOnError: true` (the default), the queue stops. The failed task stays at the
  front of the queue, so a later `start()` processes it again;
- otherwise (`stopOnError: false`) the task is retried as soon as `onError` returns. To retry with a
  delay, wait inside `onError`; to give up, call `skipCurrentTask()`.

### Failing Hooks

A hook that throws or rejects never stops the queue's own bookkeeping:

- a failing `onError` is treated as one that did not skip the task (unless it skipped it before
  failing);
- a failing `onFinish` rejects that task's `push()` promise with the hook's error; the task is not
  retried;
- failures of `onDrained` and `onStop` are ignored — handle errors inside them if they matter.

## API Reference

### `ProcessQueue<Task>` (interface)

| Method | Description |
|--------|-------------|
| `push(task)` | Adds a task to the queue; the promise settles with the task's outcome |
| `start()` | Starts processing |
| `stop()` | Stops processing, waits for in-flight tasks (see "Lifecycle") |
| `purge()` | Stops processing and drops the tasks that are waiting; their `push()` promises reject with `TaskWasPurged` |
| `isProcessing()` | Returns `true` if the queue is started — whether or not work is in flight |

### `ProcessQueueOptions<Task>`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `processor` | `(task) => Promise<any>` | required | Task processing function |
| `onError` | `(context) => Promise<any>` | required | Error handler |
| `maxProcessing` | `number` | `100` | Max tasks in flight at once (`ConcurrentProcessQueue`) |
| `autoStart` | `boolean` | `true` | Start processing on construction |
| `stopOnError` | `boolean` | `true` | Stop the queue when a failed task is not skipped |
| `onDrained` | `(queue) => Promise<any>` | — | Called when the last task in the queue has completed |
| `onFinish` | `(task) => Promise<any>` | — | Called after each task completes |
| `onStop` | `(queue) => any` | — | Called once each time the queue comes to a stop |

## License

ISC
