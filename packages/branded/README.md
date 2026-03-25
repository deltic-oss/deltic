# @deltic/branded

Branded types for nominal type safety in TypeScript.

## Why?

TypeScript uses structural typing, so two types with the same shape are interchangeable. This can lead to subtle bugs when semantically different values share the same underlying type:

```typescript
type UserId = string;
type OrderId = string;

function getOrder(orderId: OrderId) { /* ... */ }

const userId: UserId = 'user_123';
getOrder(userId); // No error — but this is a bug
```

Branded types add a compile-time tag that makes structurally identical types incompatible:

```typescript
import type {Branded} from '@deltic/branded';

type UserId = Branded<string, 'UserId'>;
type OrderId = Branded<string, 'OrderId'>;

function getOrder(orderId: OrderId) { /* ... */ }

const userId = 'user_123' as UserId;
getOrder(userId); // Type error
```

## Installation

```bash
npm install @deltic/branded
```

## Usage

```typescript
import type {Branded} from '@deltic/branded';

// Define branded types
type Email = Branded<string, 'Email'>;
type Username = Branded<string, 'Username'>;

// Create values with explicit casting
const email = 'alice@example.com' as Email;
const username = 'alice' as Username;

// Type-safe function signatures
function sendEmail(to: Email, subject: string) { /* ... */ }

sendEmail(email, 'Hello');    // OK
sendEmail(username, 'Hello'); // Type error
```

## API Reference

### `Branded<T, TBrand>`

```typescript
type Branded<T, TBrand extends string>
```

Creates a nominally-typed version of `T` using a unique symbol. The brand exists only at compile time and has no runtime cost.

## License

ISC
