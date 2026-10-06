import {isUnrecoverableError} from '@deltic/error-standard';
import {AMQPConnectionProvider, UnableToAuthenticateWithAMQP} from './connection-provider.js';

const amqpUrl = 'amqp://admin:admin@localhost:35671';

describe('AMQPConnectionProvider', () => {
    test('it can resolve a connection', async () => {
        const connectionProvider = new AMQPConnectionProvider(amqpUrl);

        try {
            const connection = await connectionProvider.connection();

            expect(connection).not.toBeUndefined();
        } finally {
            await connectionProvider.close();
        }
    });

    test('it can resolve the same connection twice', async () => {
        const connectionProvider = new AMQPConnectionProvider(amqpUrl);

        try {
            const connection1 = await connectionProvider.connection();
            const connection2 = await connectionProvider.connection();

            expect(connection1).toBe(connection2);
        } finally {
            await connectionProvider.close();
        }
    });

    test('it can resolve two different connections that are not the same', async () => {
        const connectionProvider = new AMQPConnectionProvider(amqpUrl);

        try {
            const connection1 = await connectionProvider.connection('one');
            const connection2 = await connectionProvider.connection('two');

            expect(connection1).not.toBe(connection2);
        } finally {
            await connectionProvider.close();
        }
    });

    /**
     * amqplib reports a socket failure or a missed heartbeat as an 'error' event on the
     * connection. An EventEmitter without a listener rethrows it as an uncaught exception.
     */
    test('an error reported on the connection does not escape as an uncaught exception', async () => {
        const connectionProvider = new AMQPConnectionProvider(amqpUrl);

        try {
            const connection = await connectionProvider.connection('error-reporting');

            expect(() => connection.emit('error', new Error('Heartbeat timeout'))).not.toThrow();
        } finally {
            await connectionProvider.close();
        }
    });

    test('it errors when no connection is successfully resolved', async () => {
        const connectionProvider = new AMQPConnectionProvider('amqp://admin:invalid@localhost:35671');

        await expect(() => connectionProvider.connection(undefined, 50)).rejects.toThrow();

        await connectionProvider.close();
    });

    test('it stops at once when the broker rejects the only configured credentials', async () => {
        let attempts = 0;
        const connectionProvider = new AMQPConnectionProvider(() => {
            attempts++;

            return 'amqp://admin:invalid@localhost:35671';
        });

        const error = await connectionProvider.connection().catch((error: unknown) => error);

        expect(error).toBeInstanceOf(UnableToAuthenticateWithAMQP);
        expect(isUnrecoverableError(error)).toBe(true);
        expect(attempts).toBe(1);
        await connectionProvider.close();
    });

    test('it tries every configured credential before giving up on being rejected', async () => {
        const connectionProvider = new AMQPConnectionProvider(
            () => ['amqp://admin:invalid@localhost:35671', 'amqp://also-wrong:invalid@localhost:35671'],
        );

        const error = await connectionProvider.connection().catch((error: unknown) => error);

        expect(error).toBeInstanceOf(UnableToAuthenticateWithAMQP);
        expect(String(error)).toContain('all 2 configured credentials');
        await connectionProvider.close();
    });

    test('it can resolve a working connection even when one of the URLs is invalid', async () => {
        const connectionProvider = new AMQPConnectionProvider(
            () => ['amqp://admin:invalid@localhost:35671', amqpUrl],
        );

        try {
            const connection = await connectionProvider.connection();

            expect(connection).not.toBeUndefined();
        } finally {
            await connectionProvider.close();
        }
    });
});
