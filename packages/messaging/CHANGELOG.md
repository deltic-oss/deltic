# @deltic/messaging

## 0.1.2

### Patch Changes

- 0ed7f15: Fix type references in the dist folder.
- Updated dependencies [0ed7f15]
  - @deltic/offset-tracking@0.1.2
  - @deltic/async-pg-pool@0.2.2
  - @deltic/process-queue@0.1.2
  - @deltic/wait-group@0.1.4
  - @deltic/key-value@0.1.2
  - @deltic/backoff@0.1.3
  - @deltic/context@0.1.2
  - @deltic/clock@0.1.3
  - @deltic/mutex@0.1.3

## 0.1.1

### Patch Changes

- 76018d6: Fix package.json export dist references
- Updated dependencies [76018d6]
  - @deltic/offset-tracking@0.1.1
  - @deltic/async-pg-pool@0.2.1
  - @deltic/process-queue@0.1.1
  - @deltic/wait-group@0.1.3
  - @deltic/key-value@0.1.1
  - @deltic/backoff@0.1.2
  - @deltic/context@0.1.1
  - @deltic/clock@0.1.2
  - @deltic/mutex@0.1.2

## 0.1.0

### Minor Changes

- e0b32f8: Initial release. Provides a messaging framework including:

  - `MessageRepository` interface with PostgreSQL implementation for event stream persistence.
  - `MessageDispatcher` and `MessageConsumer` interfaces with chain, decorator, and collecting implementations.
  - Transactional outbox pattern via `OutboxRepository` and `OutboxMessageDispatcher`.
  - Message upcasting support for versioned stream evolution.
  - AMQP (RabbitMQ) integration: `AMQPConnectionProvider`, `AMQPChannelPool`, `AMQPMessageDispatcher`, `AMQPMessageRelay`.
  - `MessageDeliveryCounter` interface with in-memory implementation for tracking delivery attempts.

### Patch Changes

- Updated dependencies [e0b32f8]
- Updated dependencies [e0b32f8]
- Updated dependencies [e0b32f8]
- Updated dependencies [e0b32f8]
- Updated dependencies [e0b32f8]
  - @deltic/async-pg-pool@0.2.0
  - @deltic/backoff@0.1.1
  - @deltic/clock@0.1.1
  - @deltic/wait-group@0.1.2
  - @deltic/key-value@0.1.0
  - @deltic/offset-tracking@0.1.0
  - @deltic/mutex@0.1.1
