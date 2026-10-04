# AGENTS.md - Coding Guidelines for LLM/Agentic Coding

This document defines both the agent workflow and the coding standards for the Deltic monorepo. Sections 0 and 00 govern how you work; sections 1–11 define what conventions to follow.

## Overview

Deltic is a TypeScript monorepo providing event sourcing, messaging, and infrastructure tooling. The codebase targets:

- **Node.js 22+** with ES2024 features
- **ESM-first** with CommonJS compatibility
- **pnpm workspaces** for package management
- **Strict TypeScript** with advanced type patterns

---

## 0. Agent Workflow

### 0.1 Core Stance

Prioritize technical accuracy over validating beliefs. Provide direct, objective technical info. Apply the same rigorous standards to all ideas and disagree when necessary — objective guidance and respectful correction are more valuable than false agreement. When uncertain, investigate to find the truth first rather than instinctively confirming assumptions.

### 0.2 Task Planning

Before starting any non-trivial task:

1. **Understand** — Read relevant code. Don't assume structure; verify it.
2. **Plan** — Identify what changes are needed and in what order. For multi-step tasks (3+ files, new feature, refactor), write the plan explicitly as a checklist before making any changes. Include file paths and a verification section.
3. **Execute** — Make changes incrementally. One concern per edit.
4. **Verify** — After each meaningful change, run verification (see 00. Verification Loop).

### 0.3 Code Editing Discipline

- **Read before writing**: Always read a file before editing it. Understand context, patterns, and conventions already in use.
- **Match existing patterns**: If the codebase uses a particular style, follow it. Don't introduce new patterns without reason.
- **Minimal diffs**: Change only what's necessary. Don't reformat adjacent code or add unrelated improvements unless asked.
- **No partial work**: Don't leave TODO comments for things you can resolve now. If something is out of scope, say so explicitly.
- **Reference locations**: When discussing specific code, include `file_path:line_number` for easy navigation.

### 0.4 Tool Usage

- Prefer specialized tools (read, edit, write) over bash for file operations.
- Reserve bash for actual system commands: running tests, type checkers, linters, builds, and git operations.
- Never use bash (echo, cat, sed) to communicate — write output directly in your response.
- When running a non-trivial bash command, briefly explain what it does and why.
- Use **pnpm** for all package management (not npm, not yarn).
- Use the project's own tooling (vitest, tsup, etc.) — don't substitute alternatives.

### 0.5 Communication

- Be concise. State what you're doing, do it, report the result.
- When something is wrong with the approach, say so directly and explain why.
- Don't pad responses with encouragement or filler.
- If a task is ambiguous, ask a focused clarifying question rather than guessing.

### 0.6 Error Handling During Work

- If you encounter an error you don't understand, investigate it — read source code, check types, look at recent changes. Don't guess at fixes.
- If stuck in a loop (3+ failed attempts at the same fix), stop, explain the issue, and ask for guidance rather than making speculative changes.
- Never delete or regenerate lockfiles (pnpm-lock.yaml) unless specifically asked.

---

## 00. Verification Loop

**After every file edit or write, verify your work.** This is non-negotiable.

### TypeScript Verification

After editing `.ts` or `.tsx` files, always run type checking:

```bash
npx tsc --noEmit
```

If the changed file has a co-located test (`.test.ts`), run it:

```bash
pnpm vitest run <relevant-test-file>
```

For changes that affect build output, verify the build succeeds:

```bash
pnpm run build
```

### When Verification Fails

- Fix the error in the same turn. Do not defer it.
- If a fix introduces new errors, keep iterating until clean.
- If you are stuck in a loop (3+ failed attempts), stop and explain the issue rather than making speculative changes.
- Never present work that has known type errors, lint violations, or failing tests.

---

## 1. Architecture Principles

### 1.1 Interface-First Design

Always define interfaces before implementations. Interfaces represent contracts; implementations fulfill them.

```typescript
// CORRECT: Define interface first
export interface MessageConsumer<Stream extends StreamDefinition> {
    consume(message: AnyMessageFrom<Stream>): Promise<void>;
}

// Then implement
export class DecoratingMessageConsumer<Stream extends StreamDefinition>
    implements MessageConsumer<Stream> {
    constructor(
        private readonly decorator: MessageDecorator<Stream>,
        private readonly consumer: MessageConsumer<Stream>,
    ) {}

    async consume(message: AnyMessageFrom<Stream>): Promise<void> {
        await this.consumer.consume(this.decorator.decorate([message])[0]);
    }
}
```

### 1.2 Multi-Implementation Pattern

Provide both memory-based and PostgreSQL implementations for all storage interfaces. Memory implementations are used for testing and simple use cases; PostgreSQL for production.

```typescript
// Memory implementation
export class KeyValueStoreUsingMemory<Key, Value> implements KeyValueStore<Key, Value> {
    private storage: Map<string, Value> = new Map();
    // ...
}

// PostgreSQL implementation
export class KeyValueStoreUsingPg<Key, Value> implements KeyValueStore<Key, Value> {
    constructor(
        private readonly pool: AsyncPgPool,
        readonly options: KeyValueStoreUsingPgOptions<Key>,
    ) {}
    // ...
}
```

### 1.3 Composition Over Inheritance

Prefer decorators, chains, and middleware over class inheritance. This enables flexible composition of behaviors.

```typescript
// CORRECT: Decorator pattern
export class DecoratingMessageConsumer<Stream> implements MessageConsumer<Stream> {
    constructor(
        private readonly decorator: MessageDecorator<Stream>,
        private readonly consumer: MessageConsumer<Stream>,
    ) {}
}

// CORRECT: Chain pattern, members run in order and the chain settles after the last one
export class MessageConsumerChain<Stream> implements MessageConsumer<Stream> {
    constructor(...consumers: MessageConsumer<Stream>[]) {
        this.consumers = consumers;
    }

    async consume(message: AnyMessageFrom<Stream>): Promise<void> {
        for (const consumer of this.consumers) {
            await consumer.consume(message);
        }
    }
}

// AVOID: Deep inheritance hierarchies
class BaseConsumer { ... }
class LoggingConsumer extends BaseConsumer { ... }  // Don't do this
class ValidatingLoggingConsumer extends LoggingConsumer { ... }  // Definitely don't do this
```

### 1.4 Dependency Injection via Constructor

All dependencies must be injected through constructors. Never use service locators or global state.

```typescript
// CORRECT: Constructor injection
export class EventSourcedAggregateRepository<Stream extends AggregateStream<Stream>> {
    constructor(
        protected readonly factory: AggregateRootFactory<Stream>,
        protected readonly messageRepository: MessageRepository<Stream>,
        protected readonly messageDispatcher: MessageDispatcher<Stream> | undefined = undefined,
        protected readonly transactionManager: TransactionManager,
    ) {}
}

// AVOID: Service locator pattern
class BadRepository {
    doSomething() {
        const repo = ServiceLocator.get('messageRepository');  // Don't do this
    }
}
```

### 1.5 Self-Referential Generics (F-Bounded Polymorphism)

Use self-referential generics for stream definitions to ensure type consistency across the entire event sourcing pipeline.

```typescript
// Stream references itself for type safety
export interface AggregateStream<Stream extends AggregateStream<Stream>> extends StreamDefinition {
    aggregateRoot: AggregateRoot<Stream>;
}

// Extended stream with additional constraints
export interface AggregateStreamWithSnapshotting<
    Stream extends AggregateStreamWithSnapshotting<Stream> & AggregateStream<Stream>,
> extends AggregateStream<Stream> {
    snapshot: SnapshotType;
    aggregateRoot: AggregateRootWithSnapshotting<Stream>;
}
```

---

## 2. TypeScript Style Guide

### 2.1 File Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Source files | kebab-case | `message-repository.ts` |
| Test files | `.test.ts` suffix | `message-repository.test.ts` |
| E2E tests | `.e2e.test.ts` suffix | `outbox-repository.e2e.test.ts` |
| Stubs/fixtures | `.stubs.ts` suffix | `example-stream.stubs.ts` |
| PostgreSQL implementations | In `pg/` subdirectory | `pg/message-repository.ts` |

### 2.2 Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Interfaces | PascalCase (no `I` prefix) | `MessageConsumer`, `KeyValueStore` |
| Types | PascalCase | `StreamDefinition`, `HeaderValue` |
| Classes | PascalCase | `DecoratingMessageConsumer` |
| Implementation classes | `<Purpose>Using<Backend>` | `MessageRepositoryUsingPg`, `MutexUsingMemory` |
| Decorator classes | `<Behavior><Type>Decorator` | `TenantIdMessageDecorator` |
| Functions | camelCase | `createMessage`, `messageWithHeader` |
| Factory functions | `create<Thing>` prefix | `createTestTooling`, `createMessageConsumer` |
| Variables | camelCase | `tenantContext`, `asyncPool` |
| Constants | camelCase (not SCREAMING_SNAKE) | `defaultLockTimeoutMs`, `reflectMethods` |
| Private fields | camelCase (no underscore prefix) | `private cache`, `private readonly pool` |
| Message types | snake_case | `'member_was_added'`, `'order_placed'` |
| Header keys | snake_case | `'aggregate_root_id'`, `'time_of_recording'` |
| Error codes | dot.snake_case | `'mutex.unable_to_acquire_lock'` |
| Database tables | snake_case | `event_store`, `outbox_messages` |
| Test tables | `test__` prefix | `test__kv_store`, `test__events` |

### 2.3 Interface vs Type Decision

Use **interfaces** for:
- Contracts that will be implemented by classes
- Objects with methods
- Extendable structures

```typescript
// Interface for implementable contract
export interface MessageConsumer<Stream extends StreamDefinition> {
    consume(message: AnyMessageFrom<Stream>): Promise<void>;
}

// Interface for options objects
export interface AsyncPgPoolOptions {
    keepConnections?: number;
    maxIdleMs?: number;
    onRelease?: OnReleaseCallback;
}
```

Use **types** for:
- Unions and intersections
- Mapped types
- Utility types
- Function signatures
- Recursive type definitions

```typescript
// Type for union
export type HeaderValue = undefined | null | string | number | boolean | HeaderValue[];

// Type for mapped types
export type ServiceHandlers<Service extends ServiceStructure<Service>> = {
    readonly [T in keyof Service]: (input: Service[T]['payload']) => Promise<Service[T]['response']>;
};

// Type for function signature
export type MessageConsumerFunc<Stream extends StreamDefinition> = 
    (message: AnyMessageFrom<Stream>) => Promise<void>;
```

### 2.4 Generic Type Patterns

**Use `const` for literal type preservation:**
```typescript
export function createMessage<
    const Stream extends StreamDefinition,
    const T extends AnyMessageTypeFromStream<Stream>,
>(type: T, payload: Stream['messages'][T]): Message<T, Stream['messages'][T]> {
    // ...
}
```

**Use indexed access types for stream properties:**
```typescript
async retrieve(id: Stream['aggregateRootId']): Promise<Stream['aggregateRoot']>

protected recordThat<T extends AnyMessageTypeFromStream<Stream>>(
    type: T,
    payload: Stream['messages'][T],
): void
```

**Provide sensible defaults for generics:**
```typescript
export class KeyValueStoreUsingPg<
    Key extends KeyType,
    Value extends ValueType,
    DatabaseKey extends string | number = string | number,  // Default provided
    TenantId extends string | number = string | number,     // Default provided
> implements KeyValueStore<Key, Value> {
```

**Use mapped types for exhaustive handlers:**
```typescript
export type ReducerMap<Stream extends AggregateStream<Stream>, State> = {
    [E in keyof Stream['messages']]?: (state: State, message: Message<E, Stream['messages'][E]>) => State;
};
```

### 2.5 Branded Types

Use branded types for type-safe identifiers:

```typescript
// Define brand using unique symbol
declare const brand: unique symbol;

export type Branded<T, TBrand extends string> = T & {
    [brand]: TBrand;
};

// Usage
export type PrefixedId<Prefix extends string> = Branded<`${Prefix}_${string}`, Prefix>;
type UserId = PrefixedId<'user'>;  // 'user_xxx' with compile-time safety
```

For service keys in dependency injection:
```typescript
declare const service: unique symbol;

export type ServiceKey<Service> = string & {
    [service]: Service;
};

// Escape hatch for edge cases
export function forgeServiceKey<Service>(key: string): ServiceKey<Service> {
    return key as unknown as ServiceKey<Service>;
}
```

### 2.6 Function Declarations

Prefer regular function declarations over `const` arrow functions for named functions. Always explicitly type return values.

```typescript
// CORRECT: Regular function declaration with explicit return type
function createUserMessage(username: string): UserMessage {
    return {
        type: 'user_created',
        payload: {username},
    };
}

// AVOID: const arrow function for named functions
const createUserMessage = (username: string): UserMessage => ({
    type: 'user_created',
    payload: {username},
});

// AVOID: Missing return type (relies on inference)
function createUserMessage(username: string) {
    return {
        type: 'user_created',
        payload: {username},
    };
}
```

**Exceptions where arrow functions are appropriate:**
- Inline callbacks: `array.map(x => x.id)`
- Preserving `this` context in class methods
- Function types/signatures in interfaces

### 2.7 Natural Language in Naming

Names should read like natural human language, not awkward "programmer-speak". If you wouldn't say it in conversation, don't use it as a name.

```typescript
// AVOID: Verb-noun soup that no human would say
function defaultCreateContextValue() { ... }
const getRetrieveUserData = ...
const doProcessMessageHandler = ...

// CORRECT: Natural noun phrases
function defaultContextValueCreator() { ... }  // "the default context value creator"
const messageProcessor = ...                    // "the message processor"
const userDataRetriever = ...                   // "the user data retriever"
```

**Guidelines:**

- **Functions that return things** should be named as nouns (creators, factories, builders) or with `create`/`build` prefixes
- **Functions that do things** should use imperative verbs: `process`, `validate`, `send`
- **Variables holding instances** should be nouns: `consumer`, `repository`, `handler`
- **Test what you'd say**: If explaining to a colleague, would you say "the default create context value" or "the default context value creator"?

```typescript
// AVOID: Grammatically incorrect compound names
const userGetService = ...           // "user get service"?
const createBuildMessage = ...       // "create build message"?
const handleProcessRequest = ...     // "handle process request"?

// CORRECT: Names that form sensible phrases
const userService = ...              // "the user service"
const messageBuilder = ...           // "the message builder"  
const requestHandler = ...           // "the request handler"
```

This isn't about being pedantic—clear names reduce cognitive load and make code self-documenting.

---

## 3. Code Patterns

### 3.1 Decorator Pattern

Wrap existing implementations to add behavior:

```typescript
export class DecoratingMessageConsumer<Stream extends StreamDefinition>
    implements MessageConsumer<Stream> {
    constructor(
        private readonly decorator: MessageDecorator<Stream>,
        private readonly consumer: MessageConsumer<Stream>,
    ) {}

    async consume(message: AnyMessageFrom<Stream>): Promise<void> {
        await this.consumer.consume(this.decorator.decorate([message])[0]);
    }
}
```

### 3.2 Chain of Responsibility

Build middleware chains at construction time:

```typescript
export class ServiceDispatcher<Definition extends ServiceStructure<Definition>>
    implements Service<Definition> {
    private readonly chain: ChainHandler<Definition>;

    constructor(
        private readonly handlers: ServiceHandlers<Definition>,
        private readonly middlewares: ServiceMiddleware<Definition>[] = [],
    ) {
        // Build chain from inside-out
        let next: ChainHandler<Definition> = async (type, payload) => 
            await this.process(type, payload);

        for (let index = this.middlewares.length - 1; index >= 0; index -= 1) {
            const m = this.middlewares[index];
            const n = next;
            next = async (type, input) => await m(type, input, n);
        }

        this.chain = next;
    }
}
```

### 3.3 Factory Functions

Create factory functions for interface implementations:

```typescript
// Convert function to interface implementation
export function createMessageConsumer<Stream extends StreamDefinition>(
    consume: MessageConsumerFunc<Stream>,
): MessageConsumer<Stream> {
    return {consume};
}

// Factory with configuration
export function createServiceLockingMiddleware<S extends ServiceStructure<S>, LockId>({
    mutex,
    lockResolver,
    shouldSkip = () => false,
    timeoutMs = defaultLockTimeoutMs,
}: ServiceLockingOptions<S, LockId>): ServiceMiddleware<S> {
    return async <T extends keyof S>(type: T, payload: S[T]['payload'], next: NextFunction<S>) => {
        // ...
    };
}
```

### 3.4 Error Handling with StandardError

All custom errors must extend `StandardError` with error codes and context. **Co-locate error classes with the code that throws them** — don't group errors into a shared `errors.ts` file. If an error is only thrown in one file, define it in that file.

```typescript
// In mutex.ts — the error lives next to the code that throws it
import {StandardError, errorToMessage} from '@deltic/error-standard';

export class UnableToAcquireLock extends StandardError {
    // Use static factory methods for construction
    static becauseOfError = (id: unknown, reason: unknown) =>
        new UnableToAcquireLock(
            `Unable to acquire lock for ${String(id)}: ${errorToMessage(reason)}`,
            'mutex.unable_to_acquire_lock',  // Namespaced error code
            {id: String(id)},                 // Context object
            reason,                           // Original error as cause
        );
}

// Error with multiple factory methods
export class CrossTenantOperationDetected extends StandardError {
    static forIds<TenantId extends string | number>({
        expectedId,
        tenantId,
    }: {
        expectedId: TenantId;
        tenantId: TenantId;
    }) {
        return new CrossTenantOperationDetected(
            `Cross-tenant operation detected. Expected ${String(expectedId)} detected ${String(tenantId)}`,
            'context.cross_tenant_operation_detected',
            {expectedId, tenantId},
        );
    }
}
```

### 3.5 Resource Management

Use try/finally for resource cleanup:

```typescript
async persist(key: Key, value: Value): Promise<void> {
    const connection = await this.pool.primary();
    try {
        await connection.query(/* ... */);
    } finally {
        await this.pool.release(connection);
    }
}

// For locks
async handle<T extends keyof S>(type: T, payload: S[T]['payload']): Promise<S[T]['response']> {
    const lockID = this.lockResolver({type, payload});
    await this.mutex.lock(lockID, this.timeoutMs);

    try {
        return await this.service.handle(type, payload);
    } finally {
        await this.mutex.unlock(lockID);
    }
}
```

Use `Symbol.asyncDispose` for automatic cleanup (when applicable):

```typescript
// Using 'await using' syntax
await using connection = await provider.claim();
const result = await connection.query('SELECT 1');
// Connection automatically released when block exits
```

### 3.6 Options Objects

Use options objects for complex configuration with sensible defaults:

```typescript
export interface MessageRepositoryUsingPgOptions<Stream extends StreamDefinition> {
    readonly idConversion?: IdConversion<Stream['aggregateRootId']>;
    readonly tenantIdConversion?: IdConversion<string | number>;
    readonly tenantContext?: ContextValueReader<string>;
    readonly notificationConfiguration?: NotificationConfiguration;
}

export class MessageRepositoryUsingPg<Stream extends StreamDefinition> {
    constructor(
        private readonly pool: AsyncPgPool,
        private readonly tableName: string,
        readonly options: MessageRepositoryUsingPgOptions<Stream> = {},  // Default empty
    ) {}
}
```

---

## 4. Testing Guidelines

### 4.1 Test Organization

- Tests are **co-located** with source files
- Use `.test.ts` suffix for unit tests
- Use `.e2e.test.ts` suffix for integration tests
- Use `.stubs.ts` suffix for test fixtures

```
src/
├── message-repository.ts
├── message-repository.test.ts      # Unit tests
├── pg/
│   ├── message-repository.ts
│   └── message-repository.e2e.test.ts  # Integration tests
└── example-stream.stubs.ts         # Shared fixtures
```

### 4.2 Multi-Implementation Testing with describe.each

Test all implementations with the same test suite:

```typescript
describe.each([
    ['Memory', () => new KeyValueStoreUsingMemory<ExampleKey, ExampleValue>()],
    ['Pg', () => new KeyValueStoreUsingPg<ExampleKey, ExampleValue>(asyncPool, options)],
] as const)('KeyValueStoreUsing%s', (_name, factory) => {
    let store: KeyValueStore<ExampleKey, ExampleValue>;

    beforeEach(() => {
        store = factory();
    });

    test('values can be stored and retrieved', async () => {
        await store.persist('key', 'value');
        expect(await store.retrieve('key')).toEqual('value');
    });

    // All tests run for both implementations
});
```

### 4.3 Parameterized Tests with test.each

Use for testing multiple inputs/outputs:

```typescript
test.each([
    [1, 100],
    [2, 200],
    [3, 300],
])('backs off linearly: attempt %i = %i ms', (attempt, expectedDelay) => {
    const strategy = new LinearBackoffStrategy(100);
    expect(strategy.backOff(attempt)).toEqual(expectedDelay);
});

test.each([
    ['number', 42],
    ['boolean', false],
    ['string', 'example'],
    ['object', {name: 'Frank', age: 35}],
])('stored value of type %s can be retrieved', async (_type, value) => {
    await store.persist('key', value);
    expect(await store.retrieve('key')).toEqual(value);
});
```

### 4.4 Test Structure (AAA or Given-When-Then)

Use comments to clearly separate test phases:

```typescript
// AAA Pattern
test('values can be removed', async () => {
    // arrange
    const key = 'key-a';
    await store.persist(key, {name: 'Original', age: 40});

    // act
    await store.remove(key);
    const retrievedValue = await store.retrieve(key);

    // assert
    expect(retrievedValue).toBeUndefined();
});

// Given-When-Then Pattern (for BDD-style)
test('adding a member emits event', async () => {
    // given
    await given(createMessage('group_was_created', {name: 'Test Group'}));

    // when
    await whenAggregate(async ({aggregateRoot}) => {
        aggregateRoot.addMember(frank);
    });

    // then
    then(createMessage('member_was_added', frank));
});
```

### 4.5 Test Tooling for Event Sourcing

Use the provided test tooling for aggregate testing:

```typescript
import {createTestTooling} from '@deltic/event-sourcing/test-tooling';

const {
    given,           // Set up prior events
    when,            // Execute service command
    whenAggregate,   // Directly manipulate aggregate
    then,            // Assert emitted events
    expectError,     // Expect error to be thrown
    createMessage,   // Message factory
    expectNoEvents,  // Assert no events emitted
} = createTestTooling<ExampleStream, ExampleService>(
    'aggregate-id',
    aggregateFactory,
    serviceFactory,
);

test('adding duplicate member throws error', async () => {
    await given(createMessage('member_was_added', frank));
    
    expectError(MemberAlreadyExists);
    
    await whenAggregate(async ({aggregateRoot}) => {
        aggregateRoot.addMember(frank);
    });
});
```

### 4.6 Test Doubles (No Mocking Frameworks)

Create simple test doubles instead of using mocking frameworks:

```typescript
// Collecting dispatcher for verification
export class CollectingMessageDispatcher<Stream> implements MessageDispatcher<Stream> {
    private messages: AnyMessageFrom<Stream>[] = [];
    public dispatchCount = 0;

    async send(...messages: MessagesFrom<Stream>): Promise<void> {
        this.messages.push(...messages);
        this.dispatchCount++;
    }

    producedMessages(): AnyMessageFrom<Stream>[] {
        return this.messages;
    }
}

// MockedService for service testing
export class MockedService<Definition extends ServiceStructure<Definition>> 
    implements Service<Definition> {
    private stagedResponses: StagedResponse<Definition>[] = [];
    private calledWith: AnyInputForService<Definition>[] = [];

    stageResponse<T extends keyof Definition>(response: StagedResponse<Definition>[T]): void {
        this.stagedResponses.push(response);
    }

    wasCalledWith(input: AnyInputForService<Definition>, times: number = 1): boolean {
        return this.timeCalledWith(input) >= times;
    }
}
```

### 4.7 Database Test Setup

For PostgreSQL integration tests:

```typescript
describe('MessageRepositoryUsingPg', () => {
    let pgPool: Pool;
    let asyncPool: AsyncPgPool;
    let repository: MessageRepositoryUsingPg<TestStream>;

    beforeAll(async () => {
        pgPool = new Pool(pgTestCredentials);
        asyncPool = new AsyncPgPool(pgPool);
        
        // Create test tables
        await pgPool.query(`CREATE TABLE IF NOT EXISTS test__events (...)`);
    });

    beforeEach(() => {
        repository = new MessageRepositoryUsingPg(asyncPool, 'test__events');
    });

    afterEach(async () => {
        // Clean up between tests
        await repository.truncate();
        await asyncPool.flushSharedContext();
    });

    afterAll(async () => {
        // Drop test tables and close pool
        await pgPool.query('DROP TABLE IF EXISTS test__events');
        await pgPool.end();
    });
});
```

---

## 5. PostgreSQL Integration

### 5.1 Connection Management

Use `AsyncPgPool` for connection management:

```typescript
// Claim and release pattern
async persist(id: Stream['aggregateRootId'], messages: MessagesFrom<Stream>): Promise<void> {
    const connection = await this.pool.primary();
    
    try {
        await connection.query(/* ... */);
    } finally {
        await this.pool.release(connection);
    }
}

// Transaction pattern
async runInTransaction<R>(fn: () => Promise<R>): Promise<R> {
    await this.pool.begin();
    
    try {
        const result = await fn();
        await this.pool.commit();
        return result;
    } catch (error) {
        await this.pool.rollback(error);
        throw error;
    }
}
```

### 5.2 Query Patterns

**Always use parameterized queries:**
```typescript
// CORRECT: Parameterized query
await connection.query(
    `SELECT * FROM ${this.tableName} WHERE aggregate_root_id = $1 AND version > $2`,
    [aggregateId, fromVersion],
);

// AVOID: String interpolation for values
await connection.query(
    `SELECT * FROM events WHERE id = '${id}'`,  // SQL injection risk!
);
```

**UPSERT pattern:**
```typescript
await connection.query(
    `INSERT INTO ${this.tableName} (tenant_id, "key", "value")
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, "key") DO UPDATE SET "value" = EXCLUDED."value"`,
    [tenantId, key, JSON.stringify({value})],
);
```

**JSON columns for flexible data:**
```typescript
// Store arbitrary values as JSON
type StoredRecord<V> = {
    key: string;
    value: {value: V};  // Wrapped to handle primitives
};

await connection.query(
    `INSERT INTO ${this.tableName} ("key", "value") VALUES ($1, $2)`,
    [key, JSON.stringify({value})],
);
```

### 5.3 Multi-Tenant Support

Build multi-tenancy into all storage implementations:

```typescript
export interface KeyValueStoreUsingPgOptions<Key, DatabaseKey, TenantId> {
    readonly tenantContext?: ContextValueReader<TenantId>;
    readonly tenantIdConversion?: IdConversion<TenantId>;
}

async persist(key: Key, value: Value): Promise<void> {
    const tenantId = this.tenantContext?.mustResolve();
    const columns = ['key', 'value'];
    const values = [this.keyConversion(key), JSON.stringify({value})];

    if (tenantId !== undefined) {
        columns.unshift('tenant_id');
        values.unshift(this.tenantIdConversion?.toDatabase(tenantId) ?? tenantId);
    }

    // Build query with tenant support
}
```

### 5.4 Advisory Locks for Distributed Locking

```typescript
async lock(id: LockID, timeout: number): Promise<void> {
    const client = await this.pool.claim();
    const lockId = this.idConverter.convert(id);

    try {
        await client.query(`SET SESSION lock_timeout TO '${timeout}ms'`);
        await client.query('SELECT pg_advisory_lock($1)', [lockId]);
        this.connections.set(lockId, client);
        await client.query('RESET lock_timeout');
    } catch (e) {
        await this.pool.release(client, e);
        throw UnableToAcquireLock.becauseOfError(id, e);
    }
}

async unlock(id: LockID): Promise<void> {
    const lockId = this.idConverter.convert(id);
    const client = this.connections.get(lockId);

    if (client) {
        await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
        this.connections.delete(lockId);
        await this.pool.release(client);
    }
}
```

---

## 6. Package Structure

### 6.1 Directory Layout

```
packages/<package-name>/
├── src/
│   ├── index.ts              # Main exports (interfaces, types, core)
│   ├── <feature>.ts          # Feature implementations
│   ├── <feature>.test.ts     # Co-located tests
│   ├── memory.ts             # Memory implementation (if applicable)
│   └── pg/                   # PostgreSQL implementations
│       ├── <feature>.ts
│       └── <feature>.test.ts
├── dist/                     # Build output (generated)
├── package.json
├── LICENSE.md
├── CHANGELOG.md
└── .npmignore
```

### 6.2 Package.json Exports Configuration

Use conditional exports for ESM/CJS compatibility:

```json
{
  "name": "@deltic/messaging",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "module-sync": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./pg/message-repository": {
      "import": "./dist/pg/message-repository.js",
      "require": "./dist/pg/message-repository.cjs",
      "module-sync": "./dist/pg/message-repository.js",
      "types": "./dist/pg/message-repository.d.ts"
    }
  }
}
```

### 6.3 Peer Dependencies

Use optional peer dependencies for features that require external packages:

```json
{
  "peerDependencies": {
    "pg": "^8.16.3",
    "reflect-metadata": "^0.2.2"
  },
  "peerDependenciesMeta": {
    "pg": {
      "optional": true
    },
    "reflect-metadata": {
      "optional": true
    }
  }
}
```

### 6.4 Internal Package References

Use `workspace:^` for internal dependencies:

```json
{
  "dependencies": {
    "@deltic/context": "workspace:^",
    "@deltic/error-standard": "workspace:^"
  }
}
```

---

## 7. ESLint & Formatting Rules

The codebase enforces:

```javascript
{
    rules: {
        '@typescript-eslint/no-unused-vars': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        'object-curly-spacing': ['error', 'never'],  // No spaces in braces
        quotes: ['error', 'single', {allowTemplateLiterals: false, avoidEscape: true}],
        semi: ['error', 'always'],  // Always use semicolons
    }
}
```

**Key formatting rules:**
- Single quotes for strings (no template literals unless needed)
- Semicolons required
- No spaces inside curly braces: `{foo}` not `{ foo }`
- 4-space indentation

---

## 8. Anti-Patterns to Avoid

### DON'T: Use class inheritance for code reuse
```typescript
// AVOID
class BaseRepository { ... }
class MessageRepository extends BaseRepository { ... }

// PREFER: Composition
class MessageRepository {
    constructor(private readonly baseOperations: BaseOperations) {}
}
```

### DON'T: Prefix interfaces with `I`
```typescript
// AVOID
interface IMessageConsumer { ... }

// CORRECT
interface MessageConsumer { ... }
```

### DON'T: Use SCREAMING_SNAKE_CASE for constants
```typescript
// AVOID
const DEFAULT_LOCK_TIMEOUT_MS = 5000;

// CORRECT
const defaultLockTimeoutMs = 5000;
```

### DON'T: Use mocking frameworks
```typescript
// AVOID
const mockConsumer = jest.mock<MessageConsumer>();
when(mockConsumer.consume).thenReturn(...);

// PREFER: Simple test doubles
const collectingConsumer = new CollectingMessageConsumer();
```

### DON'T: Throw plain Error
```typescript
// AVOID
throw new Error('Lock acquisition failed');

// CORRECT
throw UnableToAcquireLock.becauseOfError(id, reason);
```

### DON'T: Put implementation details in interface names
```typescript
// AVOID
interface PostgresMessageRepository { ... }

// CORRECT
interface MessageRepository { ... }
class MessageRepositoryUsingPg implements MessageRepository { ... }
```

### DON'T: Group files by type instead of purpose
```typescript
// AVOID: Grouping all errors, all types, all constants together
// src/errors.ts          (all errors dumped in one file)
// src/types.ts           (all types dumped in one file)
// src/constants.ts       (all constants dumped in one file)

// PREFER: Co-locate code with the module that uses it
// src/connection-provider.ts  (includes its own errors, types, and constants)
// src/channel-pool.ts         (includes its own errors, types, and constants)
// src/message-dispatcher.ts   (includes its own errors, types, and constants)
```

Only extract shared code into a separate file when it is genuinely used by multiple modules. A file should exist because of a shared purpose, not because of a shared code structure.

### DON'T: Create monolithic files
```typescript
// AVOID: One huge file with everything
// src/index.ts (2000+ lines)

// PREFER: Split by responsibility
// src/index.ts (interfaces and types)
// src/message-consumer.ts
// src/message-dispatcher.ts
// src/pg/message-repository.ts
```

### DON'T: Use default exports for classes
```typescript
// AVOID
export default class MessageRepository { ... }

// PREFER: Named exports
export class MessageRepository { ... }

// Exception: DependencyContainer uses both for convenience
export default DependencyContainer;
export const container = new DependencyContainer();
```

### DON'T: Use const arrow functions for named functions
```typescript
// AVOID
const processMessage = (msg: Message): void => {
    // ...
};

// CORRECT
function processMessage(msg: Message): void {
    // ...
}
```

---

## 9. Modern JavaScript/TypeScript Features Used

This codebase uses modern ES2024+ features. Ensure compatibility:

- `Promise.withResolvers()` - For creating deferred promises
- `AbortSignal.any()` - For combining abort signals
- `AbortSignal.timeout()` - For timeout-based signals
- `Symbol.asyncDispose` - For automatic resource cleanup
- `using` / `await using` - Explicit resource management
- `Array.prototype.toSorted()` - Non-mutating sort
- `process.hrtime.bigint()` - High-resolution timing

---

## 10. Quick Reference

### Creating a new interface:
```typescript
export interface MyInterface<T extends SomeConstraint<T>> {
    doSomething(input: T['inputType']): Promise<T['outputType']>;
}
```

### Creating a new implementation:
```typescript
export class MyInterfaceUsingMemory<T extends SomeConstraint<T>> 
    implements MyInterface<T> {
    constructor(private readonly dependency: Dependency) {}
    
    async doSomething(input: T['inputType']): Promise<T['outputType']> {
        // Implementation
    }
}
```

### Creating a new error:
```typescript
export class MyError extends StandardError {
    static because = (reason: string) =>
        new MyError(
            `Operation failed: ${reason}`,
            'my-package.my_error',
            {reason},
        );
}
```

### Creating a test:
```typescript
describe.each([
    ['Memory', () => new MyInterfaceUsingMemory()],
    ['Pg', () => new MyInterfaceUsingPg(pool)],
] as const)('MyInterfaceUsing%s', (_name, factory) => {
    let instance: MyInterface<TestType>;
    
    beforeEach(() => {
        instance = factory();
    });
    
    test('does something correctly', async () => {
        // arrange
        const input = createTestInput();
        
        // act
        const result = await instance.doSomething(input);
        
        // assert
        expect(result).toEqual(expectedOutput);
    });
});
```

---

## 11. Maintaining This Document

When making corrections during code review or pair programming:

1. **Reflect on prevention**: Consider whether an addition or correction to this AGENTS.md file would have prevented the issue
2. **Update proactively**: If a pattern or preference isn't documented but should be, add it
3. **Keep examples concrete**: Use real code patterns from the codebase when possible

This ensures the guidelines evolve with the codebase and reduce repeated corrections.
