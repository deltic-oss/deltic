import {EventEmitter} from 'node:events';
import {setTimeout as wait} from 'node:timers/promises';
import {StaticMutexUsingMemory} from '@deltic/mutex/static-memory';
import type {StaticMutex} from '@deltic/mutex';
import type {AsyncPgPool} from '@deltic/async-pg-pool';
import {WaitGroup} from '@deltic/wait-group';
import {StandardError} from '@deltic/error-standard';
import type {StreamDefinition} from '../index.js';
import type {OutboxRelay} from '../outbox.js';

export interface OutboxRelayRunnerOptions {
    channelName: string;
    batchSize?: number;
    commitSize?: number;
    pollIntervalMs?: number;
    lockRetryMs?: number;
}

class AlreadyStarted extends StandardError {
    static create = () =>
        new AlreadyStarted(
            'Outbox relay runner was already started',
            'messaging.outbox_relay_runner_already_started',
            {},
        );
}

export class OutboxRelayRunner<Stream extends StreamDefinition> {
    private shouldContinue = false;
    private hasLock = false;
    private dirty = false;
    private readonly singleProcessingMutex = new StaticMutexUsingMemory();
    private readonly events = new EventEmitter<{process: []}>();
    private timer: ReturnType<typeof setTimeout> | undefined;
    private waiter: PromiseWithResolvers<void> | undefined;
    private terminationWaiter: PromiseWithResolvers<void> | undefined;
    private shutdownSignal: PromiseWithResolvers<void> | undefined;
    private readonly pendingWork = new WaitGroup();
    private readonly batchSize: number;
    private readonly commitSize: number;
    private readonly pollIntervalMs: number;
    private readonly lockRetryMs: number;

    constructor(
        private readonly pool: AsyncPgPool,
        private readonly mutex: StaticMutex,
        private readonly relay: OutboxRelay<Stream>,
        private readonly options: OutboxRelayRunnerOptions,
    ) {
        this.batchSize = options.batchSize ?? 100;
        this.commitSize = options.commitSize ?? 25;
        this.pollIntervalMs = options.pollIntervalMs ?? 2500;
        this.lockRetryMs = options.lockRetryMs ?? 1000;
        this.events.on('process', () => {
            void this.processBatch().catch((err) => {
                this.shouldContinue = false;
                this.waiter?.reject(err);
            });
        });
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

                this.events.emit('process');

                try {
                    await this.waiter!.promise;
                } finally {
                    this.shouldContinue = false;
                    clearTimeout(this.timer);
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
        clearTimeout(this.timer);
        this.waiter.resolve();

        await this.terminationWaiter?.promise;
    }

    private async processBatch(): Promise<void> {
        if (!await this.singleProcessingMutex.tryLock()) {
            /**
             * A batch is already being processed. Mark as dirty so the
             * in-flight batch re-triggers when it completes, ensuring
             * the new notification is not lost.
             */
            this.dirty = true;

            return;
        }

        clearTimeout(this.timer);

        if (!this.shouldContinue) {
            await this.singleProcessingMutex.unlock();

            return;
        }

        this.pendingWork.add();
        // eslint-disable-next-line no-useless-assignment
        let relayed = 0;

        try {
            relayed = await this.relay.relayBatch(this.batchSize, this.commitSize);
        } finally {
            this.pendingWork.done();
            await this.singleProcessingMutex.unlock();
        }

        if (!this.shouldContinue) {
            return;
        }

        const wasDirty = this.dirty;
        this.dirty = false;

        if (relayed > 0 || wasDirty) {
            this.events.emit('process');
        } else {
            this.timer = setTimeout(() => this.events.emit('process'), this.pollIntervalMs);
        }
    }

    private async listenForNotification(): Promise<void> {
        this.pendingWork.add();

        try {
            const connection = await this.pool.claimFresh();
            let releaseError: unknown;

            try {
                connection.on('notification', () => {
                    this.events.emit('process');
                });

                await connection.query(`LISTEN ${this.options.channelName}`);
                await this.shutdownSignal!.promise;
            } finally {
                try {
                    await connection.query(`UNLISTEN ${this.options.channelName}`);
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
