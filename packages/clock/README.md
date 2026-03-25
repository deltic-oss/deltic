# `@deltic/clock`

Make your codebase, and especially tests, more deterministic by encapsulating time. Stop fuzzy
matching, use exact matching instead by fixating the random nature of time.

## Installation

```sh
npm i -S @deltic/clock
# or
pnpm add @deltic/clock
```

## Usage

While (date)time is global in  JavaScript environments, being tied to non-deterministic global state causes many issues.
The clock package is designed to remove this source of issues by encapsulating time. There is some cost associated with
using this over using global `Date` functionality, but the benefits largely outweigh the cost.

The package consists of three parts:

1. An interface for consumers to depend on.
2. A system-clock implementation that gives _real_ time.
3. A test-clock implementation for controlling time in tests.

### The `Clock` interface:

The interface consists of the following methods:

- `now(): number` – an equivalent of `Date.now()`
- `date(): Date` – an equivalent of `new Date()`

### Consuming time

There are two modes of consuming time; by injection or by using the `GlobalClock`.

Whenever when using injection, depend on the `Clock` interface:

```typescript
import type {Clock} from '@deltic/clock';

class MyService {
    constructor(
        private readonly clock: Clock,
    ) {
    }

    timestamp(label: string): string {
        return `${label}-${this.clock.now()}`;
    }
}
```

Or, use the globally available clock:

```typescript
import {GlobalClock} from '@deltic/clock';

function timestampLabel(label: string): string {
    return `${label}-${GlobalClock.now()}`;
}
```

### Fixating time in tests

In tests, the `GlobalClock` is an instance of the `TestClock`. The `GlobalTestClock` is the
same instance, but allows you to manipulate time.

The `TestClock` methods are:

- `tick(): void` – to advance one ms
- `advance(increment: number): void` – to advance with N amount of ms,
- `travelTo(laterTime: number | string): void` – to set the clock to a particular point in time

See it in action:

```
import {createTestClock, GlobalTestClock} from '@deltic/clock';
import {timestampLabel} from './timestamp-label.js';

describe('functionality', () => {
    test('it works', () => {
        const clock = createTestClock(); // or use GlobalTestClock
        const now = clock.now();

        expect(timestampLabel('label')).toEqual(`label-${now}`);
    });

    test('it works with a set timestamp', () => {
        const now = 1500_000_000_000;
        const clock = createTestClock(now); // or use GlobalTestClock

        expect(timestampLabel('label')).toEqual('label-1500000000000');
    });
});
```

