import {EventEmitter} from 'node:events';
import {setTimeout as wait} from 'node:timers/promises';
import {MutexUsingMemory} from '@deltic/mutex/memory';
import type {AsyncPgPool} from '@deltic/async-pg-pool';
import {WaitGroup} from '@deltic/wait-group';
import {isUnrecoverableError, StandardError} from '@deltic/error-standard';
import type {OutboxRelay} from '../outbox.js';
import {AsyncResource} from 'node:async_hooks';
import {OutboxRelayGroup} from './outbox-relay-group.js';

export interface RelayedOutbox {
    relay: OutboxRelay<any>;
    /**
     * The advisory lock that makes a process the one relaying this outbox; taking it is what starts
     * the relaying. Unique among the outboxes of the runner, and used by no other advisory lock in
     * the database.
     */
    lockId: number;
    /**
     * Outboxes of one group share a connection for their locks and notifications. Defaults to
     * `'default'`.
     */
    group?: string;
}

export interface ClaimFailure {
    group: string;
    error: unknown;
}

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
    /**
     * How often the runner takes the locks of outboxes no process holds, and checks that the
     * connections of its groups are alive. Defaults to 1000.
     */
    lockAcquisitionIntervalMs?: number;
    /**
     * The groups this process relays. Defaults to every group.
     */
    holdGroups?: string[];
    /**
     * How many outboxes are relayed at the same time. Every batch takes a connection from the pool,
     * next to the one each group holds, so this keeps the relay from starving the pool. Defaults to 10.
     */
    maxConcurrentRelays?: number;
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
    /**
     * Reports a group whose locks could not be taken or whose connection failed. The runner tries
     * again after `lockAcquisitionIntervalMs`.
     */
    onClaimFailure?: (failure: ClaimFailure) => void;
}

class AlreadyStarted extends StandardError {
    static create = () =>
        new AlreadyStarted(
            'Multi outbox relay runner was already started',
            'messaging.multi_outbox_relay_runner_already_started',
            {},
        );
}

export class DuplicateOutboxLockId extends StandardError {
    static forOutboxes = (lockId: number, first: string, second: string) =>
        new DuplicateOutboxLockId(
            `Outboxes ${first} and ${second} share lock id ${lockId}, so whichever is claimed second can never be relayed by another process`,
            'messaging.duplicate_outbox_lock_id',
            {lockId, outbox: first, sharedWith: second},
        );
}

export class MultiOutboxRelayRunner {
    private shouldContinue = false;
    private relaysInFlight = 0;
    private readonly processingMutex = new MutexUsingMemory<string>();
    private readonly dirty = new Set<string>();
    private readonly events = new EventEmitter<{process: [string]}>();
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly consecutiveFailures = new Map<string, number>();
    private readonly backingOff = new Set<string>();
    private readonly waitingForSlot = new Set<string>();
    private readonly relays = new Map<string, OutboxRelay<any>>();
    private readonly groups: OutboxRelayGroup[] = [];
    private readonly groupOf = new Map<string, OutboxRelayGroup>();
    private claimLoopStop: AbortController | undefined;
    private waiter: PromiseWithResolvers<void> | undefined;
    private terminationWaiter: PromiseWithResolvers<void> | undefined;
    private shutdownSignal: PromiseWithResolvers<void> | undefined;
    private readonly pendingWork = new WaitGroup();
    private readonly channelName: string;
    private readonly batchSize: number;
    private readonly commitSize: number;
    private readonly pollIntervalMs: number;
    private readonly lockAcquisitionIntervalMs: number;
    private readonly maxConcurrentRelays: number;
    private readonly failureBackoffCeilingMs: number;
    private readonly onRelayFailure: (failure: RelayFailure) => void;
    private readonly onClaimFailure: (failure: ClaimFailure) => void;

    /**
     * @param outboxes keyed by identifier: the payload of the notifications for the outbox, which is
     *                 its table name for `NotifyingOutboxDecoratorUsingPg`
     */
    constructor(
        private readonly pool: AsyncPgPool,
        outboxes: Record<string, RelayedOutbox>,
        options: MultiOutboxRelayRunnerOptions = {},
    ) {
        this.channelName = options.channelName ?? 'outbox_publish';
        this.batchSize = options.batchSize ?? 100;
        this.commitSize = options.commitSize ?? 25;
        this.pollIntervalMs = options.pollIntervalMs ?? 2500;
        this.lockAcquisitionIntervalMs = options.lockAcquisitionIntervalMs ?? 1000;
        this.maxConcurrentRelays = options.maxConcurrentRelays ?? 10;
        this.failureBackoffCeilingMs = options.failureBackoffCeilingMs ?? 60_000;
        this.onRelayFailure = options.onRelayFailure ?? (() => {});
        this.onClaimFailure = options.onClaimFailure ?? (() => {});

        const outboxByLockId = new Map<number, string>();
        const lockIdsByGroup = new Map<string, Map<string, number>>();

        for (const [identifier, {relay, lockId, group = 'default'}] of Object.entries(outboxes)) {
            const sharing = outboxByLockId.get(lockId);

            if (sharing !== undefined) {
                throw DuplicateOutboxLockId.forOutboxes(lockId, sharing, identifier);
            }

            outboxByLockId.set(lockId, identifier);

            if (options.holdGroups !== undefined && !options.holdGroups.includes(group)) {
                continue;
            }

            this.relays.set(identifier, relay);
            lockIdsByGroup.set(group, (lockIdsByGroup.get(group) ?? new Map()).set(identifier, lockId));
        }

        for (const [name, lockIds] of lockIdsByGroup) {
            const group = new OutboxRelayGroup(name, pool, lockIds, this.channelName, identifier => this.events.emit('process', identifier));
            this.groups.push(group);

            for (const identifier of lockIds.keys()) {
                this.groupOf.set(identifier, group);
            }
        }
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

                this.claimLoopStop = new AbortController();
                void this.claimOutboxes(this.claimLoopStop.signal);

                try {
                    await this.waiter!.promise;
                } finally {
                    this.shouldContinue = false;

                    for (const timer of this.timers.values()) {
                        clearTimeout(timer);
                    }

                    this.timers.clear();
                    this.backingOff.clear();
                    this.waitingForSlot.clear();
                    this.claimLoopStop?.abort();
                    this.shutdownSignal?.resolve();
                    await this.pendingWork.wait();

                    for (const group of this.groups) {
                        await group.release();
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
        this.waitingForSlot.clear();
        this.claimLoopStop?.abort();
        this.waiter.resolve();

        await this.terminationWaiter?.promise;
    }

    /**
     * Taking an outbox's lock is what starts relaying it. Waiting for a notification instead would
     * never start an outbox that emits none, nor one whose previous holder stopped while it was idle.
     */
    private async claimOutboxes(stop: AbortSignal): Promise<void> {
        this.pendingWork.add();

        try {
            while (this.shouldContinue) {
                for (const group of this.groups) {
                    try {
                        for (const identifier of await group.claimUnheld()) {
                            this.events.emit('process', identifier);
                        }

                        await group.heartbeat();
                    } catch (error) {
                        try {
                            this.onClaimFailure({group: group.name, error});
                        } catch {
                            // A report that fails must not stop the claiming; the failure is the reporter's to handle.
                        }
                    }
                }

                await wait(this.lockAcquisitionIntervalMs, undefined, {signal: stop}).catch(() => {});
            }
        } finally {
            this.pendingWork.done();
        }
    }

    private async processBatch(identifier: string): Promise<void> {
        /**
         * An outbox can lose its lock between being woken and being processed, so ownership is
         * checked here, before the processing mutex is taken.
         */
        if (this.groupOf.get(identifier)?.holds(identifier) !== true) {
            return;
        }

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

        const relay = this.relays.get(identifier)!;

        if (this.relaysInFlight >= this.maxConcurrentRelays) {
            this.waitingForSlot.add(identifier);
            await this.processingMutex.unlock(identifier);

            return;
        }

        this.relaysInFlight++;
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
            this.relaysInFlight--;
            this.pendingWork.done();
            await this.processingMutex.unlock(identifier);
        }

        if (!this.shouldContinue) {
            return;
        }

        this.wakeOneWaitingForSlot();

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

    private wakeOneWaitingForSlot(): void {
        const [waiting] = this.waitingForSlot;

        if (waiting === undefined) {
            return;
        }

        this.waitingForSlot.delete(waiting);
        this.events.emit('process', waiting);
    }

    /**
     * The lock is kept while backing off. Releasing it would hand the outbox to another process, which
     * would fail on the same message and hand it back, publishing every message that was dispatched but
     * not yet marked consumed again on each bounce.
     */
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
}
