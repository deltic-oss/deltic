# @deltic/event-sourcing

A rich event-sourcing implementation with aggregate roots, multiple reducer patterns, snapshotting, and projections.

## Installation

```bash
npm install @deltic/event-sourcing @deltic/messaging @deltic/clock @deltic/transaction-manager
```

## Usage

### Defining an Aggregate Stream

```typescript
import type {AggregateStream, AggregateRoot} from '@deltic/event-sourcing';

interface OrderStream extends AggregateStream<OrderStream> {
    aggregateRootId: string;
    aggregateRoot: Order;
    messages: {
        OrderPlaced: {total: number};
        OrderShipped: {trackingNumber: string};
        OrderCancelled: {reason: string};
    };
}
```

### Implementing an Aggregate Root

Extend `AggregateRootBehavior` and implement `apply()` to handle events:

```typescript
import {AggregateRootBehavior} from '@deltic/event-sourcing';

class Order extends AggregateRootBehavior<OrderStream> {
    private total = 0;
    private status: 'pending' | 'shipped' | 'cancelled' = 'pending';

    static place(id: string, total: number): Order {
        const order = new Order(id);
        order.recordThat('OrderPlaced', {total});
        return order;
    }

    ship(trackingNumber: string): void {
        this.recordThat('OrderShipped', {trackingNumber});
    }

    protected apply(message: AnyMessageFrom<OrderStream>): void {
        switch (message.type) {
            case 'OrderPlaced':
                this.total = message.payload.total;
                break;
            case 'OrderShipped':
                this.status = 'shipped';
                break;
            case 'OrderCancelled':
                this.status = 'cancelled';
                break;
        }
    }
}
```

### Using a Handler Map

For explicit event-to-handler mapping:

```typescript
import {AggregateRootUsingHandlerMap} from '@deltic/event-sourcing/using-handler-map';

class Order extends AggregateRootUsingHandlerMap<OrderStream> {
    protected handlers = {
        OrderPlaced: (message) => { this.total = message.payload.total; },
        OrderShipped: (message) => { this.status = 'shipped'; },
        OrderCancelled: (message) => { this.status = 'cancelled'; },
    };
}
```

### Using a Reducer Function

For functional-style state management:

```typescript
import {AggregateRootUsingReducerFunc} from '@deltic/event-sourcing/using-reducer-func';

type OrderState = {total: number; status: string};

class Order extends AggregateRootUsingReducerFunc<OrderStream, OrderState> {
    constructor(id: string) {
        super(id, {total: 0, status: 'pending'});
    }

    protected reduce(state: OrderState, message: AnyMessageFrom<OrderStream>): OrderState {
        switch (message.type) {
            case 'OrderPlaced':
                return {...state, total: message.payload.total};
            case 'OrderShipped':
                return {...state, status: 'shipped'};
            default:
                return state;
        }
    }
}
```

### Using Reflect Metadata Decorators

```typescript
import {AggregateRootUsingReflectMetadata, makeEventHandler} from '@deltic/event-sourcing/using-reflect-metadata';

const handle = makeEventHandler<OrderStream>();

class Order extends AggregateRootUsingReflectMetadata<OrderStream> {
    @handle('OrderPlaced')
    onOrderPlaced(message: SpecificMessageFrom<OrderStream, 'OrderPlaced'>) {
        this.total = message.payload.total;
    }
}
```

### Repository

Persist and retrieve aggregates:

```typescript
import {EventSourcedAggregateRepository} from '@deltic/event-sourcing';

const repository = new EventSourcedAggregateRepository<OrderStream>(
    orderFactory,
    messageRepository,
    messageDispatcher,   // optional: dispatch events on persist
    messageDecorator,    // optional: decorate events before storage
    transactionManager,
);

// Retrieve
const order = await repository.retrieve(orderId);
const orderAtV3 = await repository.retrieveAtVersion(orderId, 3);

// Persist
const order = Order.place('order-1', 99.99);
await repository.persist(order);
```

### Snapshotting

Speed up reconstitution by storing aggregate state snapshots:

```typescript
import {AggregateRootRepositoryWithSnapshotting} from '@deltic/event-sourcing/snapshotting';

const repository = new AggregateRootRepositoryWithSnapshotting<OrderStream>(
    orderFactory,
    snapshotRepository,
    messageRepository,
    messageDispatcher,
    messageDecorator,
    false, // authoritativeSnapshots — if true, snapshots are trusted without replaying events
    transactionManager,
);

// Persist with snapshot
await repository.persist(order, true); // second arg stores a snapshot
```

### Aggregate Projections

Automatically project aggregate state on persist:

```typescript
import {AggregateRepositoryWithProjector} from '@deltic/event-sourcing/aggregate-projection';

const repository = new AggregateRepositoryWithProjector<OrderStream>(
    eventSourcedRepository,
    projector,
    transactionManager,
);

// Projector runs after every persist
await repository.persist(order);
```

## API Reference

### Core Interfaces

| Interface | Description |
|-----------|-------------|
| `AggregateStream<Stream>` | Defines aggregate ID, root type, and message shapes |
| `AggregateRoot<Stream>` | Aggregate root with event recording |
| `AggregateRootFactory<Stream>` | Reconstitutes aggregates from events |
| `AggregateRepository<Stream>` | Persist and retrieve aggregates |

### `AggregateRoot<Stream>` Methods

| Method | Description |
|--------|-------------|
| `releaseEvents()` | Returns and clears unreleased events |
| `peekEvents()` | Returns a copy of unreleased events |
| `hasUnreleasedEvents()` | Whether there are uncommitted events |
| `aggregateRootVersion()` | Current version number |

### Base Classes

| Class | Import | Description |
|-------|--------|-------------|
| `AggregateRootBehavior` | `@deltic/event-sourcing` | Abstract base with `recordThat()` and `apply()` |
| `AggregateRootUsingHandlerMap` | `@deltic/event-sourcing/using-handler-map` | Event-to-handler map |
| `AggregateRootUsingReducerFunc` | `@deltic/event-sourcing/using-reducer-func` | Functional reducer |
| `AggregateRootUsingReflectMetadata` | `@deltic/event-sourcing/using-reflect-metadata` | Decorator-based handlers |

### Entry Points

| Import | Description |
|--------|-------------|
| `@deltic/event-sourcing` | Core aggregate types and repository |
| `@deltic/event-sourcing/using-handler-map` | Handler map base class |
| `@deltic/event-sourcing/using-reducer-func` | Reducer function base class |
| `@deltic/event-sourcing/using-reducer-map` | Reducer map implementation |
| `@deltic/event-sourcing/using-reflect-metadata` | Decorator-based handlers |
| `@deltic/event-sourcing/snapshotting` | Snapshot support |
| `@deltic/event-sourcing/aggregate-projection` | Projection support |
| `@deltic/event-sourcing/test-tooling` | Testing helpers |
| `@deltic/event-sourcing/pg/snapshot-repository` | PostgreSQL snapshot storage |

## License

ISC
