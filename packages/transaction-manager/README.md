# @deltic/transaction-manager

A contract-based transaction management interface for unit-of-work patterns.

## Installation

```bash
npm install @deltic/transaction-manager
```

## Usage

### Interface

Depend on the `TransactionManager` interface to keep domain code free of infrastructure details:

```typescript
import type {TransactionManager} from '@deltic/transaction-manager';

class OrderService {
    constructor(private readonly transactions: TransactionManager) {}

    async placeOrder(order: Order) {
        await this.transactions.runInTransaction(async () => {
            await this.orderRepo.save(order);
            await this.outbox.dispatch(new OrderPlaced(order.id));
        });
    }
}
```

### Implementations

The concrete implementation is provided by `@deltic/async-pg-pool`:

```typescript
import {TransactionManagerUsingPg} from '@deltic/async-pg-pool';

const transactionManager = new TransactionManagerUsingPg(asyncPool);
```

For testing, use the no-op implementation:

```typescript
import {NoopTransactionManager} from '@deltic/transaction-manager';

const transactionManager = new NoopTransactionManager();
```

### Isolation

Run operations in an isolated context with separate connection state:

```typescript
await transactionManager.runInIsolation(async () => {
    // Connections here are independent of the outer context
});

// Or combine isolation with a transaction
await transactionManager.runInIsolatedTransaction(async () => {
    // Isolated context + automatic transaction management
});
```

## API Reference

### `TransactionManager` (interface)

| Method | Description |
|--------|-------------|
| `begin()` | Starts a transaction |
| `commit()` | Commits the active transaction |
| `rollback(error?)` | Rolls back the active transaction |
| `inTransaction()` | Returns `true` if a transaction is active |
| `runInTransaction(fn)` | Runs a function with automatic commit/rollback |
| `runInIsolation(fn)` | Runs a function in an isolated connection context |
| `runInIsolatedTransaction(fn)` | Combines isolation and transaction management |

### `NoopTransactionManager`

A no-op implementation that runs callbacks directly without transaction management. Useful for testing or non-transactional contexts.

## License

ISC
