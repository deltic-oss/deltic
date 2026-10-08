import {EventEmitter} from 'node:events';
import {setTimeout as wait} from 'node:timers/promises';
import {MutexUsingMemory} from '@deltic/mutex/memory';
import type {StaticMutex} from '@deltic/mutex';
import type {AsyncPgPool} from '@deltic/async-pg-pool';
import {WaitGroup} from '@deltic/wait-group';
import {isUnrecoverableError, StandardError} from '@deltic/error-standard';
import type {OutboxRelay} from '../outbox.js';
import {AsyncResource} from 'node:async_hooks';

export interface RelayFailure {
    identifier: string;
    error: unknown;
    consecutiveFailures: number;
    retryInMs: number;
}

export interface MultiOutboxRelayRunnerOptions {
    channelName?: string;
    batchSize?: number;
    commitSize?: number;
    pollIntervalMs?: number;
    lockRetryMs?: number;
    /**
     * The longest wait between two attempts at an outbox whose batches keep failing. The wait starts
     * at `pollIntervalMs` and doubles with every failure in a row. Defaults to 60 seconds.
     */
    failureBackoffCeilingMs?: number;
    /**
     * Reports a failed batch that will be retried. A failure that cannot be recovered from is not
     * reported here: it ends the run, and `start()` rejects with it.
     */
    onRelayFailure?: (failure: RelayFailure) => void;
}

class AlreadyStarted extends StandardError {
    static create = () =>
        new AlreadyStarted(
            'Multi outbox relay runner was already started',
            'messaging.multi_outbox_relay_runner_already_started',
            {},
        );
}

export class MultiOutboxRelayRunner {
    private shouldContinue = false;
    private hasLock = false;
    private readonly processingMutex = new MutexUsingMemory<string>();
    private readonly dirty = new Set<string>();
    private readonly events = new EventEmitter<{process: [string]}>();
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly consecutiveFailures = new Map<string, number>();
    private readonly backingOff = new Set<string>();
    private waiter: PromiseWithResolvers<void> | undefined;
    private terminationWaiter: PromiseWithResolvers<void> | undefined;
    private shutdownSignal: PromiseWithResolvers<void> | undefined;
    private readonly pendingWork = new WaitGroup();
    private readonly channelName: string;
    private readonly batchSize: number;
    private readonly commitSize: number;
    private readonly pollIntervalMs: number;
    private readonly lockRetryMs: number;
    private readonly failureBackoffCeilingMs: number;
    private readonly onRelayFailure: (failure: RelayFailure) => void;
    private readonly identifiers: string[];

    constructor(
        private readonly pool: AsyncPgPool,
        private readonly mutex: StaticMutex,
        private readonly relays: Record<string, OutboxRelay<any>>,
        options: MultiOutboxRelayRunnerOptions = {},
    ) {
        this.channelName = options.channelName ?? 'outbox_publish';
        this.batchSize = options.batchSize ?? 100;
        this.commitSize = options.commitSize ?? 25;
        this.pollIntervalMs = options.pollIntervalMs ?? 2500;
        this.lockRetryMs = options.lockRetryMs ?? 1000;
        this.failureBackoffCeilingMs = options.failureBackoffCeilingMs ?? 60_000;
        this.onRelayFailure = options.onRelayFailure ?? (() => {});
        this.identifiers = Object.keys(relays);
    }

    async start(): Promise<void> {
        if (this.waiter) {
            throw AlreadyStarted.create();
        }

        this.shouldContinue = true;
        this.waiter = Promise.withResolvers();
        this.terminationWaiter = Promise.withResolvers();
        this.shutdownSignal = Promise.withResolvers();

        try {
            await this.pool.runInIsolation(async () => {
                this.events.removeAllListeners('process');
                this.events.on('process', AsyncResource.bind((identifier: string) => {
                    void this.processBatch(identifier).catch((err) => {
                        this.shouldContinue = false;
                        this.waiter?.reject(err);
                    });
                }));

                while (this.shouldContinue) {
                    if (await this.mutex.tryLock()) {
                        this.hasLock = true;
                        break;
                    }

                    if (this.shouldContinue) {
                        await wait(this.lockRetryMs);
                    }
                }

                if (!this.shouldContinue) {
                    if (this.hasLock) {
                        await this.mutex.unlock();
                        this.hasLock = false;
                    }

                    return;
                }

                void this.listenForNotification().catch((err) => {
                    this.shouldContinue = false;
                    this.waiter?.reject(err);
                });

                for (const identifier of this.identifiers) {
                    this.events.emit('process', identifier);
                }

                try {
                    await this.waiter!.promise;
                } finally {
                    this.shouldContinue = false;

                    for (const timer of this.timers.values()) {
                        clearTimeout(timer);
                    }

                    this.timers.clear();
                    this.backingOff.clear();
                    this.shutdownSignal?.resolve();
                    await this.pendingWork.wait();

                    if (this.hasLock) {
                        await this.mutex.unlock();
                        this.hasLock = false;
                    }

                    await this.pool.flush();
                }
            });
        } finally {
            this.terminationWaiter!.resolve();
            this.waiter = undefined;
            this.terminationWaiter = undefined;
            this.shutdownSignal = undefined;
        }
    }

    async stop(): Promise<void> {
        if (!this.waiter) {
            return;
        }

        this.shouldContinue = false;

        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }

        this.timers.clear();
        this.backingOff.clear();
        this.waiter.resolve();

        await this.terminationWaiter?.promise;
    }

    private async processBatch(identifier: string): Promise<void> {
        if (this.backingOff.has(identifier)) {
            // A notification does not cut a backoff short; the scheduled retry picks up its message.
            return;
        }

        if (!await this.processingMutex.tryLock(identifier)) {
            /**
             * A batch for this identifier is already being processed.
             * Mark it as dirty so the in-flight batch re-triggers when
             * it completes, ensuring the new notification is not lost.
             */
            this.dirty.add(identifier);

            return;
        }

        const existingTimer = this.timers.get(identifier);

        if (existingTimer !== undefined) {
            clearTimeout(existingTimer);
            this.timers.delete(identifier);
        }

        if (!this.shouldContinue) {
            await this.processingMutex.unlock(identifier);

            return;
        }

        const relay = this.relays[identifier];

        if (relay === undefined) {
            await this.processingMutex.unlock(identifier);

            return;
        }

        this.pendingWork.add();
        let relayed = 0;
        let failed = false;
        let failure: unknown = undefined;

        try {
            relayed = await relay.relayBatch(this.batchSize, this.commitSize);
        } catch (error) {
            failed = true;
            failure = error;
        } finally {
            this.pendingWork.done();
            await this.processingMutex.unlock(identifier);
        }

        if (!this.shouldContinue) {
            return;
        }

        if (failed) {
            if (isUnrecoverableError(failure)) {
                // Retrying cannot help, so the failure ends the run and start() rejects with it.
                throw failure;
            }

            this.backOffAfterFailure(identifier, failure);

            return;
        }

        this.consecutiveFailures.delete(identifier);

        if (relayed > 0 || this.dirty.delete(identifier)) {
            this.events.emit('process', identifier);
        } else {
            this.timers.set(
                identifier,
                setTimeout(() => this.events.emit('process', identifier), this.pollIntervalMs),
            );
        }
    }

    private backOffAfterFailure(identifier: string, error: unknown): void {
        const consecutiveFailures = (this.consecutiveFailures.get(identifier) ?? 0) + 1;
        const retryInMs = Math.min(this.pollIntervalMs * 2 ** (consecutiveFailures - 1), this.failureBackoffCeilingMs);
        this.consecutiveFailures.set(identifier, consecutiveFailures);
        this.dirty.delete(identifier);
        this.backingOff.add(identifier);
        this.timers.set(
            identifier,
            setTimeout(() => {
                this.backingOff.delete(identifier);
                this.events.emit('process', identifier);
            }, retryInMs),
        );

        try {
            this.onRelayFailure({identifier, error, consecutiveFailures, retryInMs});
        } catch {
            // A report that fails must not stop the relay; the failure is the reporter's to handle.
        }
    }

    private async listenForNotification(): Promise<void> {
        this.pendingWork.add();

        try {
            const connection = await this.pool.claimFresh();
            let releaseError: unknown;

            try {
                connection.on('notification', AsyncResource.bind((notification) => {
                    const identifier = notification.payload;

                    if (identifier !== undefined && identifier in this.relays) {
                        this.events.emit('process', identifier);
                    }
                }));

                await connection.query(`LISTEN ${this.channelName}`);
                await this.shutdownSignal!.promise;
            } finally {
                try {
                    await connection.query(`UNLISTEN ${this.channelName}`);
                } catch (err) {
                    releaseError = err;
                }

                connection.removeAllListeners('notification');
                await this.pool.release(connection, releaseError);
            }
        } finally {
            this.pendingWork.done();
        }
    }
}
