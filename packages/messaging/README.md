# @deltic/messaging

A rich messaging abstraction for event-driven systems with support for dispatching, consuming, decorating, outbox patterns, and AMQP/RabbitMQ integration.

## Installation

```bash
npm install @deltic/messaging
```

Additional dependencies are optional depending on which features you use:

```bash
# PostgreSQL message storage and outbox
npm install @deltic/async-pg-pool pg

# AMQP/RabbitMQ dispatching
npm install amqplib

# Locking, context, offset tracking
npm install @deltic/mutex @deltic/context @deltic/offset-tracking
```

## Usage

### Defining a Stream

A stream defines the aggregate root ID type and the messages it produces:

```typescript
import type {StreamDefinition} from '@deltic/messaging';

interface OrderStream extends StreamDefinition {
    aggregateRootId: string;
    messages: {
        OrderPlaced: {orderId: string; total: number};
        OrderShipped: {orderId: string; trackingNumber: string};
        OrderCancelled: {orderId: string; reason: string};
    };
}
```

### Messages

Messages carry a type, payload, and headers:

```typescript
import type {Message} from '@deltic/messaging';

type OrderPlacedMessage = Message<'OrderPlaced', {orderId: string; total: number}, string>;
// {
//     type: 'OrderPlaced';
//     payload: {orderId: string; total: number};
//     headers: {aggregate_root_id?: string; aggregate_root_version?: number; ...};
// }
```

### Message Repository

Persist and retrieve messages for aggregates:

```typescript
import type {MessageRepository} from '@deltic/messaging';

const repo: MessageRepository<OrderStream> = /* implementation */;

// Persist messages
await repo.persist(orderId, messages);

// Retrieve all messages for an aggregate
for await (const message of repo.retrieveAllForAggregate(orderId)) {
    console.log(message.type, message.payload);
}

// Retrieve messages after a specific version
for await (const message of repo.retrieveAllAfterVersion(orderId, 5)) {
    // messages with version > 5
}
```

#### In-Memory Repository

```typescript
import {MessageRepositoryUsingMemory} from '@deltic/messaging/message-repository-using-memory';

const repo = new MessageRepositoryUsingMemory<OrderStream>();
```

### Message Dispatcher

Send messages to external systems:

```typescript
import type {MessageDispatcher} from '@deltic/messaging';

const dispatcher: MessageDispatcher<OrderStream> = /* implementation */;
await dispatcher.send(orderPlacedMessage, orderShippedMessage);
```

### Message Consumer

Process incoming messages:

```typescript
import type {MessageConsumer} from '@deltic/messaging';

const consumer: MessageConsumer<OrderStream> = {
    async consume(message) {
        switch (message.type) {
            case 'OrderPlaced':
                await handleOrderPlaced(message.payload);
                break;
        }
    },
};
```

### Message Decorators

Enrich messages with additional headers:

```typescript
import {ContextMessageDecorator} from '@deltic/messaging/context-message-decorator';
import {DecoratorForEventIds} from '@deltic/messaging/decorator-for-event-ids';
import {MessageDecoratorChain} from '@deltic/messaging/message-decorator-chain';

const decorator = new MessageDecoratorChain([
    new DecoratorForEventIds(idGenerator),
    new ContextMessageDecorator(context),
]);
```

### Consumer Composition

Chain multiple consumers, add locking, or dispatch to type-specific handlers:

```typescript
import {DispatchingMessageConsumer} from '@deltic/messaging/dispatching-message-consumer';
import {LockingMessageConsumer} from '@deltic/messaging/locking-message-consumer';
import {SequentialMessageConsumer} from '@deltic/messaging/sequential-message-consumer';
import {MessageConsumerChain} from '@deltic/messaging/message-consumer-chain';
```

`MessageConsumerChain` and `MessageDispatcherChain` run their members one after the other, in the
order they were given, and stop at the first failure. Order is therefore something you can rely on —
put the outbox dispatcher before synchronous consumers, or a projection before the webhook that embeds
it. A chain settles only once none of its members is running, so a lock or transaction scoped around
it covers everything the chain did. The members before a failing one have already handled the
message; when the failure leads to a redelivery they receive it again, so they need to be idempotent.

```typescript
const consumer = new MessageConsumerChain(updateProjection, sendWebhook);
```

### Outbox Pattern

Reliable message delivery through the outbox pattern:

```typescript
import type {Outbox} from '@deltic/messaging/outbox';
import {OutboxRepositoryUsingPg} from '@deltic/messaging/pg/outbox-repository';
import {OutboxRelayRunner} from '@deltic/messaging/pg/outbox-relay-runner';
```

### AMQP/RabbitMQ

Dispatch messages to RabbitMQ:

```typescript
import {AMQPConnectionProvider} from '@deltic/messaging/amqp/connection-provider';
import {AMQPChannelPool} from '@deltic/messaging/amqp/channel-pool';
import {AMQPMessageDispatcher} from '@deltic/messaging/amqp/message-dispatcher';
import {AMQPMessageRelay} from '@deltic/messaging/amqp/message-relay';
```

When the connection drops, the channel pool stops handing out the channels that died with it and
opens new ones on a fresh connection, and a relay re-attaches its consumers; a relay that cannot
start consuming (a queue that does not exist yet, for instance) retries once a second. Reaching the
broker is retried for at most `healingTimeout` milliseconds of continuous failure (60 seconds by
default, an `AMQPConnectionProviderOptions` option), and a broker that rejects every configured
credential is not retried at all. Both give-ups are unrecoverable errors (`UnableToHealAMQPConnection`,
`UnableToAuthenticateWithAMQP`, recognised by `isUnrecoverableError` from `@deltic/error-standard`):
the dispatcher passes them on unwrapped instead of spending its remaining tries, and a relay ends
its run with them — `start()` rejects — so the process can exit and be restarted. A caller that
must not wait out the healing window, such as one serving a request, bounds each attempt with the
pool's `connectionTimeout`, which fails with an ordinary `UnableToEstablishConnection`.

A relay hands the consumer the message parsed from each delivery's JSON body. A delivery that cannot
be read that way (not JSON, or not an object with a string `type`) is rejected without being
requeued: it goes to the queue's dead-letter exchange when one is configured, and is dropped
otherwise.

### Upcasting

Handle schema evolution by transforming messages from older versions:

```typescript
import {UpcasterUpcastingMessageRepository} from '@deltic/messaging/upcasting';
```

## API Reference

### Core Interfaces

| Interface | Description |
|-----------|-------------|
| `StreamDefinition` | Defines aggregate root ID type and message shapes |
| `Message<Type, Payload>` | A message with type, payload, and headers |
| `MessageRepository<Stream>` | Persist and retrieve messages per aggregate |
| `MessageDispatcher<Stream>` | Send messages to external consumers |
| `MessageConsumer<Stream>` | Process individual messages |
| `MessageDecorator<Stream>` | Enrich messages with additional headers |

### `MessageRepository<Stream>` Methods

| Method | Description |
|--------|-------------|
| `persist(id, messages)` | Persists messages for an aggregate |
| `retrieveAllForAggregate(id)` | All messages as an async generator |
| `retrieveAllAfterVersion(id, version)` | Messages after a specific version |
| `retrieveAllUntilVersion(id, version)` | Messages up to a specific version |
| `retrieveBetweenVersions(id, after, before)` | Messages within a version range |
| `paginateIds(options)` | Paginate aggregate IDs with stream offsets |

### Entry Points

| Import | Description |
|--------|-------------|
| `@deltic/messaging` | Core types and interfaces |
| `@deltic/messaging/message-repository-using-memory` | In-memory message storage |
| `@deltic/messaging/collecting-message-dispatcher` | Collects dispatched messages (testing) |
| `@deltic/messaging/collecting-message-consumer` | Collects consumed messages (testing) |
| `@deltic/messaging/consuming-message-dispatcher` | Routes dispatched messages to a consumer |
| `@deltic/messaging/dispatching-message-consumer` | Dispatches to type-specific handlers |
| `@deltic/messaging/decorating-message-consumer` | Wraps a consumer with decoration |
| `@deltic/messaging/message-consumer-chain` | Runs multiple consumers in order |
| `@deltic/messaging/message-decorator-chain` | Chains multiple decorators |
| `@deltic/messaging/message-dispatcher-chain` | Runs multiple dispatchers in order |
| `@deltic/messaging/locking-message-consumer` | Adds mutex locking to consumption |
| `@deltic/messaging/sequential-message-consumer` | Sequential message processing |
| `@deltic/messaging/reducing-message-consumer` | Reduce pattern for consumers |
| `@deltic/messaging/exactly-once-message-consumer-decorator` | Idempotent message processing |
| `@deltic/messaging/context-message-decorator` | Adds context values to headers |
| `@deltic/messaging/decorator-for-event-ids` | Adds unique IDs to events |
| `@deltic/messaging/tenant-id-decorator` | Adds tenant ID to headers |
| `@deltic/messaging/tenant-scoping-message-consumer` | Scopes consumption to tenant context |
| `@deltic/messaging/run-message-consumer-in-context` | Runs consumer within async context |
| `@deltic/messaging/message-delivery-counter` | Tracks delivery counts |
| `@deltic/messaging/outbox` | Outbox interface |
| `@deltic/messaging/upcasting` | Message schema evolution |
| `@deltic/messaging/pg/*` | PostgreSQL implementations |
| `@deltic/messaging/amqp/*` | AMQP/RabbitMQ implementations |

## License

ISC
