import {connect, type ChannelModel} from 'amqplib';
import {setTimeout as wait} from 'timers/promises';
import {type BackOffStrategy, MaxAttemptsExceeded} from '@deltic/backoff';
import {LinearBackoffStrategy} from '@deltic/backoff/linear';
import type {Clock} from '@deltic/clock';
import {StandardError, errorToMessage, type UnrecoverableError} from '@deltic/error-standard';

export class UnableToEstablishConnection extends StandardError {
    static becauseOfTimeout = (identifier: string) =>
        new UnableToEstablishConnection(
            `Unable to establish AMQP connection "${identifier}" within the given timeout`,
            'amqp.unable_to_establish_connection',
            {identifier},
        );

    static becauseOfError = (identifier: string, reason: unknown) =>
        new UnableToEstablishConnection(
            `Unable to establish AMQP connection "${identifier}": ${errorToMessage(reason)}`,
            'amqp.unable_to_establish_connection',
            {identifier},
            reason,
        );
}

export class ConnectionShuttingDown extends StandardError {
    static forIdentifier = (identifier: string) =>
        new ConnectionShuttingDown(
            `AMQP connection "${identifier}" is shutting down`,
            'amqp.connection_shutting_down',
            {identifier},
        );
}

export class UnableToAuthenticateWithAMQP extends StandardError implements UnrecoverableError {
    readonly isUnrecoverable = true as const;

    static becauseEveryCredentialWasRejected = (identifier: string, credentialCount: number, reason: unknown) =>
        new UnableToAuthenticateWithAMQP(
            `The broker rejected all ${credentialCount} configured credentials for the "${identifier}" `
            + 'AMQP connection. Retrying cannot make the broker accept them.',
            'amqp.unable_to_authenticate',
            {identifier, credentialCount},
            reason,
        );
}

export class UnableToHealAMQPConnection extends StandardError implements UnrecoverableError {
    readonly isUnrecoverable = true as const;

    static afterTryingFor = (identifier: string, durationMs: number, reason: unknown) =>
        new UnableToHealAMQPConnection(
            `Unable to establish the "${identifier}" AMQP connection after retrying for ${durationMs}ms: `
            + errorToMessage(reason),
            'amqp.unable_to_heal_connection',
            {identifier, durationMs},
            reason,
        );
}

export type ConnectionUrl = string | string[] | (() => string | string[]);
export type ResolvedConnectionUrls = string[];

export type AMQPConnectionProviderOptions = {
    heartbeat?: number;
    /**
     * Paces the attempts to reach the broker. A strategy that gives up (throws
     * `MaxAttemptsExceeded`) ends the attempt the same way an exhausted healing window does.
     */
    backoff?: BackOffStrategy;
    /**
     * How many milliseconds one attempt to reach the broker may keep retrying before it stops
     * trying to heal. Losing a connection is normal and the next attempt usually restores it, but
     * retrying without reaching the broker for this long is not something more attempts will fix.
     * Giving up produces an unrecoverable error, so the process can end on it and be restarted
     * rather than stay alive with nothing to publish to. Defaults to 60 seconds; pass `Infinity`
     * to retry until the provider is closed.
     */
    healingTimeout?: number;
    /**
     * Measures the healing window. Defaults to the system time.
     */
    clock?: Clock;
};

const defaultHeartbeat = 15;
const defaultHealingTimeout = 60_000;

/**
 * Measuring the healing window only needs the current time. Defined here rather than imported, so
 * the connection provider does not need `@deltic/clock` installed unless a clock is passed in.
 */
const systemClock: Clock = {
    now: () => Date.now(),
    date: () => new Date(),
};

/**
 * amqplib reports a rejected login as a plain Error carrying nothing but a message, built from the
 * AMQP reply code the broker sent:
 *
 *     Handshake terminated by server: 403 (ACCESS-REFUSED) with message "ACCESS_REFUSED - Login
 *     was refused using authentication mechanism PLAIN. For details see the broker logfile."
 *
 * There is no code or type to branch on, so the string is all there is. The constant name is taken
 * from the protocol definition rather than from the broker's own reply text, which makes it the
 * part of the message least likely to be reworded.
 */
function isRejectedLogin(error: unknown): boolean {
    return error instanceof Error && error.message.includes('(ACCESS-REFUSED)');
}

export class AMQPConnectionProvider {
    private shuttingDown: boolean = false;
    private index: number = -1;
    private readonly connections: Map<string, ChannelModel> = new Map();
    private readonly waiters: Map<string, Promise<ChannelModel>> = new Map();
    private readonly heartbeat: number;
    private readonly backoff: BackOffStrategy;
    private readonly healingTimeout: number;
    private readonly clock: Clock;

    constructor(
        private readonly connectionUrl: ConnectionUrl,
        options: AMQPConnectionProviderOptions = {},
    ) {
        this.heartbeat = options.heartbeat ?? defaultHeartbeat;
        this.backoff = options.backoff ?? new LinearBackoffStrategy(100);
        this.healingTimeout = options.healingTimeout ?? defaultHealingTimeout;
        this.clock = options.clock ?? systemClock;
    }

    async connection(identifier: string = 'shared', timeout: undefined | number = undefined): Promise<ChannelModel> {
        if (this.shuttingDown) {
            throw ConnectionShuttingDown.forIdentifier(identifier);
        }

        const currentConnection = this.connections.get(identifier);

        if (currentConnection) {
            return currentConnection;
        }

        /**
         * When multiple processes are asking for the same connection, use
         * the same promise to bundle the requests. In this scenario, the first
         * call registers the promise. Subsequent calls resolve the promise,
         * which, when resolved, provides them with the connection.
         */
        const currentPromise = this.waiters.get(identifier);

        if (currentPromise !== undefined) {
            return currentPromise;
        }

        const {promise, reject, resolve} = Promise.withResolvers<ChannelModel>();
        this.waiters.set(identifier, promise);

        /**
         * The bundling promise is only ever awaited by callers that arrive while a connect is
         * already in flight. Without a handler of its own, a failed connect that nobody happened
         * to be waiting on surfaces as an unhandled rejection.
         */
        void promise.catch(() => undefined);

        try {
            const connection = await this.establishConnection(identifier, timeout);
            resolve(connection);

            return connection;
        } catch (error) {
            reject(error);

            throw error;
        } finally {
            /**
             * A waiter bundles callers for the duration of one connect attempt and no longer.
             * A settled one left behind is the outcome every later caller would be handed, which
             * would make a single failed connect permanent.
             */
            this.waiters.delete(identifier);
        }
    }

    /**
     * The healing window is measured within this call and nowhere else. It answers "this attempt
     * has been retrying for longer than the broker is allowed to stay away", which is only true
     * while the retrying is continuous. Carrying the streak across calls would let a failure from
     * an hour ago condemn the first attempt of an unrelated one.
     */
    private async establishConnection(identifier: string, timeout: number | undefined): Promise<ChannelModel> {
        let keepGoing = true;
        let attempt = 0;
        let lastError: unknown = undefined;
        let retryingSince: number | undefined = undefined;
        let credentialsRejectedInARow = 0;
        const timer = timeout === undefined
            ? undefined
            : setTimeout(() => {
                keepGoing = false;
            }, timeout);

        try {
            while (keepGoing && !this.shuttingDown) {
                const urls = this.resolveNextCredentials(this.connectionUrl);
                this.index++;

                if (this.index >= urls.length) {
                    this.index = 0;
                }

                try {
                    const connectionUrl = this.applyConnectionOptions(urls[this.index]);
                    const connection = await connect(connectionUrl);

                    /**
                     * amqplib emits 'error' for a socket failure or a missed heartbeat, and an
                     * EventEmitter without an 'error' listener turns that into an uncaught
                     * exception. The 'close' event that always follows is what this provider acts
                     * on, so the error itself only has to be absorbed.
                     */
                    connection.on('error', () => undefined);

                    /**
                     * Forgetting the connection here is what makes the next caller establish a
                     * new one. Everything built on top of it, channels included, dies with it.
                     */
                    connection.on('close', () => {
                        this.connections.delete(identifier);
                    });

                    this.connections.set(identifier, connection);

                    return connection;
                } catch (error) {
                    lastError = error;

                    /**
                     * A broker that rejects the credentials is answering, so there is nothing to
                     * wait out. Only the whole configured set counts: one entry may be stale while
                     * another still works, which is what listing several of them is for.
                     */
                    credentialsRejectedInARow = isRejectedLogin(error) ? credentialsRejectedInARow + 1 : 0;

                    if (credentialsRejectedInARow >= urls.length) {
                        throw UnableToAuthenticateWithAMQP.becauseEveryCredentialWasRejected(
                            identifier,
                            urls.length,
                            error,
                        );
                    }
                }

                retryingSince ??= this.clock.now();
                const retryingFor = this.clock.now() - retryingSince;

                if (retryingFor >= this.healingTimeout) {
                    throw UnableToHealAMQPConnection.afterTryingFor(identifier, retryingFor, lastError);
                }

                await wait(this.delayBeforeAttempt(++attempt, identifier, retryingFor, lastError));
            }
        } finally {
            clearTimeout(timer);
        }

        throw lastError !== undefined
            ? UnableToEstablishConnection.becauseOfError(identifier, lastError)
            : UnableToEstablishConnection.becauseOfTimeout(identifier);
    }

    /**
     * A bounded strategy announces that it has run out of attempts by throwing. That is a decision
     * to stop healing, and it is reported as one, carrying the failure that kept the broker away.
     */
    private delayBeforeAttempt(attempt: number, identifier: string, retryingFor: number, lastError: unknown): number {
        try {
            return this.backoff.backOff(attempt);
        } catch (error) {
            if (error instanceof MaxAttemptsExceeded) {
                throw UnableToHealAMQPConnection.afterTryingFor(identifier, retryingFor, lastError);
            }

            throw error;
        }
    }

    private applyConnectionOptions(url: string): string {
        const parsed = new URL(url);
        parsed.searchParams.set('heartbeat', String(this.heartbeat));

        return parsed.toString();
    }

    /**
     * Credentials are expected to be resolved in the same order each time. This is important
     * because the resolution mechanism will try to loop through them and try each variant. But,
     * during the connection phase, the credentials can change, for which they need to be re-fetched
     * on every try.
     */
    private resolveNextCredentials(urls: ConnectionUrl): ResolvedConnectionUrls {
        if (typeof urls === 'function') {
            urls = urls();
        }

        if (Array.isArray(urls)) {
            return urls;
        }

        return [urls];
    }

    async close(): Promise<void> {
        this.shuttingDown = true;

        /**
         * Wait for all in progress connections to settle (rejected or resolved). This ensures
         * that we can now know there won't be any more connections incoming and we can go and
         * close all active connections.
         */
        await Promise.allSettled(Array.from(this.waiters.values()));

        /**
         * A connection that already went down rejects on close, which must not fail the shutdown
         * that is trying to tidy it up.
         */
        await Promise.allSettled(Array.from(
            this.connections.values(),
            connection => connection.close(),
        ));
    }
}
