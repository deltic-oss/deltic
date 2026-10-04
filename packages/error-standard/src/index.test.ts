import {
    type ErrorContext,
    errorToMessage,
    isUnrecoverableError,
    StandardError,
    type UnrecoverableError,
} from './index.js';

/**
 * The fixtures below mirror how the rest of the monorepo subclasses StandardError:
 * a named subclass with static factory methods that build the message, pick a code,
 * attach structured context and forward the original failure as the cause.
 * See packages/async-pg-pool/src/index.ts, packages/messaging/src/amqp/*.ts,
 * packages/mutex/src/index.ts and packages/context/src/index.ts.
 */
class UserNotFound extends StandardError {
    static forId(id: string) {
        return new UserNotFound(`User ${id} not found`, 'user.not_found', {userId: id});
    }

    static withContext(context: ErrorContext) {
        return new UserNotFound('User not found', 'user.not_found', context);
    }
}

class UnableToClaimConnection extends StandardError {
    static because(cause: unknown) {
        return new UnableToClaimConnection(
            `Unable to claim connection: ${errorToMessage(cause)}`,
            'async-pg-pool.unable_to_claim_connection',
            {},
            cause,
        );
    }
}

class UnableToDispatchMessages extends StandardError {
    static afterRetries(maxTries: number, cause: unknown) {
        return new UnableToDispatchMessages(
            `Unable to dispatch messages after ${maxTries} attempt(s): ${errorToMessage(cause)}`,
            'amqp.unable_to_dispatch_messages',
            {maxTries},
            cause,
        );
    }
}

class UnableToProvideActiveTransaction extends StandardError {
    static noTransactionWasActive(cause?: unknown) {
        return new UnableToProvideActiveTransaction(
            'Unable to provide active transaction: no transaction was active',
            'async-pg-pool.no_active_transaction_available',
            {},
            cause,
        );
    }
}

class RunnerAlreadyStarted extends StandardError {
    static create() {
        return new RunnerAlreadyStarted(
            'Outbox relay runner was already started',
            'messaging.outbox_relay_runner_already_started',
            {},
        );
    }
}

/** Mirrors context.UnableToResolveValue: a subclass that fixes message and code in its own constructor. */
class UnableToResolveValue extends StandardError {
    constructor() {
        super('Value is not found. Forgot to set it?', 'context.unable_to_resolve_value');
    }
}

/** A sibling subclass that intentionally shares the message and code of another one. */
class RunnerAlreadyStopped extends StandardError {
    static create() {
        return new RunnerAlreadyStopped(
            'Outbox relay runner was already started',
            'messaging.outbox_relay_runner_already_started',
            {},
        );
    }
}

/** Mirrors the AMQP connection provider giving up on a broker it cannot reach. */
class UnableToReachBroker extends StandardError implements UnrecoverableError {
    readonly isUnrecoverable = true as const;

    static afterTryingFor(durationMs: number) {
        return new UnableToReachBroker(
            `Unable to reach the broker after retrying for ${durationMs}ms`,
            'amqp.unable_to_heal_connection',
            {durationMs},
        );
    }
}

function collectFailureChain(error: unknown): {code: string, context: ErrorContext}[] {
    const chain: {code: string, context: ErrorContext}[] = [];
    let current: unknown = error;

    while (current instanceof StandardError) {
        chain.push({code: current.code, context: current.context});
        current = current.cause;
    }

    return chain;
}

describe('@deltic/error-standard', () => {
    describe('StandardError', () => {
        test('a factory exposes the message, code and context it was built with', () => {
            const error = UserNotFound.forId('u-1');

            expect(error.message).toBe('User u-1 not found');
            expect(error.code).toBe('user.not_found');
            expect(error.context).toEqual({userId: 'u-1'});
        });

        test('a subclass with a fixed message and code needs no arguments', () => {
            const error = new UnableToResolveValue();

            expect(error.message).toBe('Value is not found. Forgot to set it?');
            expect(error.code).toBe('context.unable_to_resolve_value');
            expect(error.context).toEqual({});
        });

        test('is catchable as its own subclass, as StandardError and as Error', () => {
            const error = RunnerAlreadyStarted.create();

            expect(error).toBeInstanceOf(RunnerAlreadyStarted);
            expect(error).toBeInstanceOf(StandardError);
            expect(error).toBeInstanceOf(Error);
            expect(() => {
                throw error;
            }).toThrow(RunnerAlreadyStarted);
        });

        test('sibling subclasses stay distinguishable even when message and code are identical', () => {
            const started = RunnerAlreadyStarted.create();
            const stopped = RunnerAlreadyStopped.create();

            expect(started).toBeInstanceOf(RunnerAlreadyStarted);
            expect(started).not.toBeInstanceOf(RunnerAlreadyStopped);
            expect(stopped).not.toBeInstanceOf(RunnerAlreadyStarted);
        });

        test('defaults the context to an empty object that is not shared between instances', () => {
            const first = UnableToClaimConnection.because(new Error('a'));
            const second = UnableToClaimConnection.because(new Error('b'));
            const withoutContext = new UnableToResolveValue();
            const alsoWithoutContext = new UnableToResolveValue();

            expect(withoutContext.context).toEqual({});
            expect(withoutContext.context).not.toBe(alsoWithoutContext.context);
            expect(first.context).not.toBe(second.context);
        });

        test('captures a stack trace pointing at the factory that created the error', () => {
            const error = UserNotFound.forId('u-1');
            const [header, topFrame] = (error.stack ?? '').split('\n');

            expect(header).toContain('User u-1 not found');
            expect(topFrame).toContain('UserNotFound.forId');
        });

        test('reports the subclass name so logs and stack traces identify the error type', () => {
            const error = UserNotFound.forId('u-1');

            expect(error.name).toBe('UserNotFound');
            expect(error.toString()).toBe('UserNotFound: User u-1 not found');
        });

        test('treats context keys as plain data, even when they name prototype members', () => {
            const untrustedContext = JSON.parse(
                '{"__proto__": {"polluted": true}, "constructor": "from-request", "prototype": "from-request"}',
            ) as ErrorContext;

            const error = UserNotFound.withContext(untrustedContext);

            expect(Object.getPrototypeOf(error.context)).toBe(Object.prototype);
            expect('polluted' in {}).toBe(false);
            expect(error.context['constructor']).toBe('from-request');
            expect(error.context['prototype']).toBe('from-request');
        });

        test('accepts the full range of declared context values', () => {
            const error = UserNotFound.withContext({
                attempt: 0,
                identifier: '',
                unicodeName: 'ünïcødé 🎉',
                deleted: false,
                tenantId: null,
                huge: Number.MAX_SAFE_INTEGER,
            });

            expect(error.context).toEqual({
                attempt: 0,
                identifier: '',
                unicodeName: 'ünïcødé 🎉',
                deleted: false,
                tenantId: null,
                huge: Number.MAX_SAFE_INTEGER,
            });
        });
    });

    describe('StandardError cause chains', () => {
        test('keeps an Error cause reachable', () => {
            const driverFailure = new Error('Connection terminated unexpectedly');
            const error = UnableToClaimConnection.because(driverFailure);

            expect(error.cause).toBe(driverFailure);
        });

        test('keeps a non-Error cause exactly as it was thrown', () => {
            const rejectionValue = 'ECONNRESET';
            const error = UnableToClaimConnection.because(rejectionValue);

            expect(error.cause).toBe('ECONNRESET');
            expect(error.message).toBe('Unable to claim connection: ECONNRESET');
        });

        test('omits cause entirely when a factory forwards an optional error that is absent', () => {
            const withoutCause = UnableToProvideActiveTransaction.noTransactionWasActive();

            expect('cause' in withoutCause).toBe(false);
            expect(withoutCause.cause).toBeUndefined();
        });

        test('omitting the cause and passing undefined explicitly behave the same', () => {
            const explicitlyUndefined = UnableToProvideActiveTransaction.noTransactionWasActive(undefined);

            expect('cause' in explicitlyUndefined).toBe(false);
        });

        test('keeps a null cause as a present but empty cause', () => {
            const withNullCause = UnableToProvideActiveTransaction.noTransactionWasActive(null);

            expect('cause' in withNullCause).toBe(true);
            expect(withNullCause.cause).toBeNull();
        });

        test('preserves the whole failure chain when each layer wraps the one below it', () => {
            const driverFailure = new Error('Connection terminated unexpectedly');
            const poolFailure = UnableToClaimConnection.because(driverFailure);
            const dispatchFailure = UnableToDispatchMessages.afterRetries(3, poolFailure);

            expect(dispatchFailure.message).toBe(
                'Unable to dispatch messages after 3 attempt(s): '
                + 'Unable to claim connection: Connection terminated unexpectedly',
            );
            expect(dispatchFailure.cause).toBe(poolFailure);
            expect(poolFailure.cause).toBe(driverFailure);
        });

        test('a reporter can walk the cause chain to collect every code and context', () => {
            const dispatchFailure = UnableToDispatchMessages.afterRetries(
                3,
                UnableToClaimConnection.because(new Error('Connection terminated unexpectedly')),
            );

            expect(collectFailureChain(dispatchFailure)).toEqual([
                {code: 'amqp.unable_to_dispatch_messages', context: {maxTries: 3}},
                {code: 'async-pg-pool.unable_to_claim_connection', context: {}},
            ]);
        });
    });

    describe('StandardError structured logging', () => {
        test('keeps code and context available to a JSON logger', () => {
            const error = UserNotFound.forId('u-1');

            const logged = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;

            expect(logged['code']).toBe('user.not_found');
            expect(logged['context']).toEqual({userId: 'u-1'});
        });

        test('serialises the message and the cause alongside code and context', () => {
            const error = UnableToClaimConnection.because(new Error('Connection terminated unexpectedly'));

            const logged = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;

            expect(Object.keys(logged).sort()).toEqual(['cause', 'code', 'context', 'message', 'name']);
            expect(logged['message']).toBe('Unable to claim connection: Connection terminated unexpectedly');
            expect(logged['name']).toBe('UnableToClaimConnection');
            expect(logged['cause']).toEqual({name: 'Error', message: 'Connection terminated unexpectedly'});
        });

        test('serialises the whole failure chain, one layer per cause', () => {
            const driverFailure = Object.assign(new Error('Connection terminated unexpectedly'), {
                code: 'ECONNRESET',
            });
            const claimFailure = UnableToClaimConnection.because(driverFailure);
            const error = UnableToDispatchMessages.afterRetries(3, claimFailure);

            const logged = JSON.parse(JSON.stringify(error)) as {cause: {cause: unknown, code: unknown}};

            // A wrapped StandardError keeps its code and context; a wrapped driver error keeps
            // the code that identifies it. Neither serialises to {} any more.
            expect(logged.cause).toEqual({
                name: 'UnableToClaimConnection',
                message: 'Unable to claim connection: Connection terminated unexpectedly',
                code: 'async-pg-pool.unable_to_claim_connection',
                context: {},
                cause: {
                    name: 'Error',
                    message: 'Connection terminated unexpectedly',
                    code: 'ECONNRESET',
                },
            });
        });

        test('leaves the stack out of the JSON payload, and Object.keys unchanged', () => {
            const error = UserNotFound.forId('u-1');

            expect(JSON.stringify(error)).not.toContain('index.test');
            expect(Object.keys(error)).toEqual(['code', 'context']);
        });

        test('cuts a cyclic cause chain instead of failing to serialise', () => {
            const first = new Error('first');
            const second = new Error('second');
            first.cause = second;
            second.cause = first;

            const error = UnableToClaimConnection.because(first);

            // Native JSON.stringify throws on circular structures; a logging payload must not.
            expect(() => JSON.stringify(error)).not.toThrow();
        });
    });

    describe('errorToMessage', () => {
        test.each([
            ['an Error', new Error('Connection terminated unexpectedly'), 'Connection terminated unexpectedly'],
            ['a StandardError subclass', UserNotFound.forId('u-1'), 'User u-1 not found'],
            ['a TypeError', new TypeError('x is not a function'), 'x is not a function'],
            ['a string rejection value', 'ECONNRESET', 'ECONNRESET'],
            ['a numeric rejection value', 42, '42'],
            ['a boolean rejection value', false, 'false'],
        ])('extracts a message from %s', (_label, value, expected) => {
            expect(errorToMessage(value)).toBe(expected);
        });

        test('extracts only the message, so the code must be reported separately', () => {
            const error = UserNotFound.forId('u-1');

            expect(errorToMessage(error)).toBe('User u-1 not found');
            expect(errorToMessage(error)).not.toContain('user.not_found');
        });

        test('does not throw for a symbol rejection value', () => {
            // Guards against a future rewrite using template interpolation, which throws for symbols.
            expect(errorToMessage(Symbol('rejected'))).toBe('Symbol(rejected)');
        });

        test('reports the string representation of a value without a usable message', () => {
            // The documented behaviour: nothing is invented for a value that carries no message,
            // its string representation is reported as-is.
            expect(errorToMessage({})).toBe('[object Object]');
            expect(errorToMessage(undefined)).toBe('undefined');
            expect(errorToMessage(null)).toBe('null');
        });

        it('reports the underlying failures of an AggregateError', () => {
            // Node produces exactly this for a refused connection on a dual-stack host,
            // which is what packages/messaging/src/amqp/connection-provider.ts wraps.
            const aggregate = new AggregateError([
                new Error('connect ECONNREFUSED 127.0.0.1:5672'),
                new Error('connect ECONNREFUSED ::1:5672'),
            ]);

            expect(errorToMessage(aggregate)).toBe(
                'connect ECONNREFUSED 127.0.0.1:5672; connect ECONNREFUSED ::1:5672',
            );
        });

        it('counts aggregated failures beyond the first few instead of describing them all', () => {
            // A Promise.any over a large fan-out must not amplify into one enormous log line.
            const aggregate = new AggregateError(
                Array.from({length: 50}, (_, index) => new Error(`attempt ${index} failed`)),
            );

            expect(errorToMessage(aggregate)).toBe(
                'attempt 0 failed; attempt 1 failed; attempt 2 failed; and 47 more',
            );
        });

        it('reports the name and code of an error with an empty message', () => {
            const systemError = Object.assign(new Error(), {code: 'ECONNREFUSED'});

            expect(errorToMessage(systemError)).toBe('Error (ECONNREFUSED)');
            expect(errorToMessage(new Error())).toBe('Error');
        });

        // see .claude-work/issues/error-standard-message-extraction-can-throw.md
        it.fails('does not mask the original failure when the thrown value cannot be stringified', () => {
            const withFailingConversion = {
                toString() {
                    throw new Error('toString exploded');
                },
            };

            expect(() => UnableToClaimConnection.because(withFailingConversion)).not.toThrow();
            expect(() => errorToMessage(Object.create(null))).not.toThrow();
        });
    });

    describe('isUnrecoverableError', () => {
        it('recognises an error that is marked as unrecoverable', () => {
            expect(isUnrecoverableError(UnableToReachBroker.afterTryingFor(60_000))).toBe(true);
        });

        it('recognises the marker on errors that do not extend StandardError', () => {
            const marked = Object.assign(new Error('gave up'), {isUnrecoverable: true});

            expect(isUnrecoverableError(marked)).toBe(true);
        });

        it.each([
            ['an ordinary StandardError', UserNotFound.forId('frank')],
            ['a plain Error', new Error('try again')],
            ['an error whose marker is not exactly true', Object.assign(new Error('maybe'), {isUnrecoverable: 'yes'})],
            ['a plain object carrying the marker', {isUnrecoverable: true}],
            ['a thrown string', 'unrecoverable'],
            ['undefined', undefined],
        ])('does not treat %s as unrecoverable', (_description, error) => {
            expect(isUnrecoverableError(error)).toBe(false);
        });

        it('does not look through the cause chain', () => {
            const wrapped = UnableToDispatchMessages.afterRetries(1, UnableToReachBroker.afterTryingFor(60_000));

            expect(isUnrecoverableError(wrapped)).toBe(false);
        });
    });
});
