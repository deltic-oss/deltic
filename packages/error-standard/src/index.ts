export type ErrorContext = {[index: string]: string | number | null | boolean};

export abstract class StandardError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly context: ErrorContext = {},
        cause: unknown = undefined,
    ) {
        const options = cause === undefined ? undefined : {cause};
        super(message, options);
        // Without this, every subclass reports itself as plain `Error` in stack traces and
        // error-tracking dashboards. Defined non-enumerably to match Error semantics, so
        // `Object.keys` and spreads stay unchanged — JSON output gets the name through `toJSON`.
        // Assigned before anything reads `.stack`, so the lazily built header carries it too.
        Object.defineProperty(this, 'name', {
            value: new.target.name,
            configurable: true,
            writable: true,
        });
    }

    /**
     * `message`, `stack` and `cause` are non-enumerable per the Error specification, so without
     * this a JSON log line contained only `code` and `context` — it looked complete while omitting
     * the human-readable message and the entire cause chain, which is the package's headline
     * feature. The stack is deliberately left out to keep log payloads small; reporters that want
     * it can read `error.stack` directly.
     */
    toJSON(): Record<string, unknown> {
        return {
            name: this.name,
            message: this.message,
            code: this.code,
            context: this.context,
            cause: this.cause === undefined ? undefined : describeCauseForJSON(this.cause, maximumCauseChainDepth),
        };
    }
}

/**
 * Beyond this many wrapping layers the chain is cut with a plain message. Guards against cyclic
 * cause graphs, which native JSON.stringify would reject with a TypeError — from inside a logging
 * pipeline, of all places.
 */
const maximumCauseChainDepth = 4;

/**
 * Errors serialise to `{}` for the same non-enumerable-property reason StandardError needed a
 * `toJSON`, so the cause chain is described as plain objects: name, message, the `code` that
 * identifies system and driver errors, and the layers beneath.
 */
function describeCauseForJSON(cause: unknown, remainingDepth: number): unknown {
    if (!(cause instanceof Error)) {
        return cause;
    }

    if (remainingDepth <= 0) {
        return errorToMessage(cause);
    }

    const description: Record<string, unknown> = {
        name: cause.name,
        message: cause.message,
    };

    if ('code' in cause && typeof cause.code === 'string') {
        description['code'] = cause.code;
    }

    if (cause instanceof StandardError) {
        description['code'] = cause.code;
        description['context'] = cause.context;
    }

    if (cause instanceof AggregateError && cause.errors.length > 0) {
        const described: unknown[] = cause.errors
            .slice(0, maximumDescribedAggregatedErrors)
            .map(aggregated => describeCauseForJSON(aggregated, remainingDepth - 1));
        const undescribed = cause.errors.length - described.length;

        if (undescribed > 0) {
            described.push(`and ${undescribed} more`);
        }

        description['errors'] = described;
    }

    if (cause.cause !== undefined) {
        description['cause'] = describeCauseForJSON(cause.cause, remainingDepth - 1);
    }

    return description;
}

export function errorToMessage(error: unknown): string {
    return describeError(error, 3);
}

/**
 * Marks an error that retrying cannot resolve. Loops that swallow failures and try again must
 * rethrow these instead, so they reach the top of the process and end it rather than keeping a
 * worker alive against a dependency that is not coming back.
 */
export interface UnrecoverableError {
    readonly isUnrecoverable: true;
}

/**
 * Recognises an unrecoverable error by its marker rather than by its class, so the check holds
 * across package boundaries and duplicated installs, where `instanceof` does not.
 */
export function isUnrecoverableError(error: unknown): error is Error & UnrecoverableError {
    return error instanceof Error && 'isUnrecoverable' in error && error.isUnrecoverable === true;
}

/**
 * Aggregated failures beyond this many are counted rather than described, so an aggregate over a
 * large fan-out cannot amplify one log line into thousands of joined messages.
 */
const maximumDescribedAggregatedErrors = 3;

function describeError(error: unknown, remainingDepth: number): string {
    // An AggregateError's diagnostics live in `errors`, not `message` — Node reports a refused
    // connection on a dual-stack host as an AggregateError with an *empty* message and one
    // sub-error per address. Reporting the message alone turned the most common infrastructure
    // failure into a log line with no content. The depth limit keeps a nested — or cyclic —
    // aggregate from unwinding for ever.
    if (remainingDepth > 0 && error instanceof AggregateError && error.errors.length > 0) {
        const descriptions = error.errors
            .slice(0, maximumDescribedAggregatedErrors)
            .map(aggregated => describeError(aggregated, remainingDepth - 1));
        const undescribed = error.errors.length - descriptions.length;

        if (undescribed > 0) {
            descriptions.push(`and ${undescribed} more`);
        }

        return descriptions.join('; ');
    }

    if (error instanceof Error) {
        if (error.message !== '') {
            return error.message;
        }

        // An empty message still has a name, and system errors carry the code — ECONNREFUSED,
        // ETIMEDOUT — that actually identifies the failure.
        const code = 'code' in error && typeof error.code === 'string' ? ` (${error.code})` : '';

        return `${error.name}${code}`;
    }

    return representationOf(error);
}

/**
 * `String()` never throws for primitives, symbols included, but it does for an object without a
 * prototype and for one whose `toString` or `Symbol.toPrimitive` throws. Message extraction runs
 * while a failure is being reported, so a second failure here would replace the first one.
 */
function representationOf(value: unknown): string {
    try {
        return String(value);
    } catch {
        return '[unprintable object]';
    }
}
