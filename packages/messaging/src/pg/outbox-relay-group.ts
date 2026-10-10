import {AsyncResource} from 'node:async_hooks';
import type {AsyncPgPool, Connection} from '@deltic/async-pg-pool';

/**
 * One connection carrying the advisory lock of every outbox in a group, and the subscription to their
 * notifications.
 *
 * Keeping both on one connection keeps ownership honest: a connection that dies drops its locks and
 * stops delivering notifications at the same instant, so the relay never believes it holds an outbox
 * that another process has taken over.
 */
export class OutboxRelayGroup {
    private connection: Connection | undefined = undefined;
    private readonly held = new Set<string>();

    constructor(
        readonly name: string,
        private readonly pool: AsyncPgPool,
        private readonly lockIds: ReadonlyMap<string, number>,
        private readonly channelName: string,
        private readonly onNotification: (identifier: string) => void,
    ) {}

    holds(identifier: string): boolean {
        return this.held.has(identifier);
    }

    /**
     * Takes the lock of every outbox in the group that no other process holds, and returns the
     * outboxes it took.
     */
    async claimUnheld(): Promise<string[]> {
        const connection = await this.currentConnection();
        const claimed: string[] = [];

        for (const [identifier, lockId] of this.lockIds) {
            if (this.held.has(identifier)) {
                continue;
            }

            const {rows} = await connection.query<{locked: boolean}>('SELECT pg_try_advisory_lock($1) AS locked', [lockId]);

            if (rows[0]?.locked === true) {
                this.held.add(identifier);
                claimed.push(identifier);
            }
        }

        return claimed;
    }

    /**
     * Uses the connection, so that one the server has dropped is noticed and its outboxes are released.
     */
    async heartbeat(): Promise<void> {
        const connection = await this.currentConnection();
        await connection.query('SELECT 1');
    }

    async release(): Promise<void> {
        const connection = this.connection;
        this.connection = undefined;
        this.held.clear();

        if (connection === undefined) {
            return;
        }

        connection.removeAllListeners('notification');
        connection.removeAllListeners('error');
        connection.removeAllListeners('end');
        let failure: unknown = undefined;

        try {
            await connection.query(`UNLISTEN ${this.channelName}`);
            await connection.query('SELECT pg_advisory_unlock_all()');
        } catch (error) {
            failure = error;
        }

        await this.pool.release(connection, failure);
    }

    /**
     * A connection that failed took its locks with it, so its outboxes are dropped rather than kept.
     * The next claim takes whatever is still free, and an outbox another process has taken over in the
     * meantime stays with it.
     */
    private async discard(connection: Connection, failure: unknown): Promise<void> {
        if (this.connection !== connection) {
            return;
        }

        this.connection = undefined;
        this.held.clear();
        connection.removeAllListeners('notification');
        await this.pool.release(connection, failure);
    }

    private async currentConnection(): Promise<Connection> {
        if (this.connection !== undefined) {
            return this.connection;
        }

        const connection = await this.pool.claimFresh();
        connection.on('notification', AsyncResource.bind((notification: {payload?: string}) => {
            if (notification.payload !== undefined && this.held.has(notification.payload)) {
                this.onNotification(notification.payload);
            }
        }));
        connection.on('error', AsyncResource.bind((error: unknown) => void this.discard(connection, error)));
        connection.on('end', AsyncResource.bind(() => void this.discard(
            connection,
            new Error(`The connection of outbox relay group ${this.name} ended`),
        )));

        try {
            await connection.query(`LISTEN ${this.channelName}`);
        } catch (error) {
            connection.removeAllListeners('notification');
            await this.pool.release(connection, error);

            throw error;
        }

        this.connection = connection;

        return connection;
    }
}
