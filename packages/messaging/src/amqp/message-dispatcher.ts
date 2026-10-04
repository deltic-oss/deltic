import {type ConfirmChannel} from 'amqplib';
import {StandardError, errorToMessage, isUnrecoverableError} from '@deltic/error-standard';
import type {AnyMessageFrom, MessageDispatcher, MessagesFrom, StreamDefinition} from '../index.js';
import {type AMQPChannelPool} from './channel-pool.js';

export class UnableToDispatchMessages extends StandardError {
    static afterRetries = (maxTries: number, reason: unknown) =>
        new UnableToDispatchMessages(
            `Unable to dispatch messages to RabbitMQ after ${maxTries} attempt(s): ${errorToMessage(reason)}`,
            'amqp.unable_to_dispatch_messages',
            {maxTries},
            reason,
        );
}

export type RoutingKeyResolver<Stream extends StreamDefinition> =
    (message: AnyMessageFrom<Stream>) => string;

export type ExchangeResolver<Stream extends StreamDefinition> =
    string | ((message: AnyMessageFrom<Stream>) => string);

export type AMQPMessageDispatcherOptions<Stream extends StreamDefinition> = {
    exchange: ExchangeResolver<Stream>;
    routingKey?: RoutingKeyResolver<Stream>;
    maxTries?: number;
};

export class AMQPMessageDispatcher<Stream extends StreamDefinition> implements MessageDispatcher<Stream> {
    private readonly exchangeResolver: ExchangeResolver<Stream>;
    private readonly keyResolver: RoutingKeyResolver<Stream>;
    private readonly maxTries: number;

    constructor(
        private readonly channelPool: AMQPChannelPool,
        options: AMQPMessageDispatcherOptions<Stream>,
    ) {
        this.exchangeResolver = options.exchange;
        this.keyResolver = options.routingKey ?? ((message) => String(message.type));
        this.maxTries = options.maxTries ?? 1;
    }

    async send(...messages: MessagesFrom<Stream>): Promise<void> {
        if (messages.length === 0) {
            return;
        }

        let tries = this.maxTries;
        let channel: ConfirmChannel | undefined = undefined;
        let lastError: unknown = undefined;

        while (tries > 0) {
            tries--;
            try {
                channel = await this.channelPool.channel();
                return await this.publishMessages(channel, messages);
            } catch (error) {
                lastError = error;

                /**
                 * The connection provider only reports this after it has already spent its whole
                 * healing window trying to reach the broker. Spending the remaining tries on it
                 * would only delay the process ending on the failure.
                 */
                if (isUnrecoverableError(error)) {
                    break;
                }
            } finally {
                if (channel !== undefined) {
                    /**
                     * Forgotten before the release rather than after, because the next try can
                     * fail at acquiring a channel. Releasing this one a second time then throws
                     * out of the finally and replaces the failure the caller needs to see.
                     */
                    const leased = channel;
                    channel = undefined;
                    await this.channelPool.release(leased);
                }
            }
        }

        /**
         * Passed on as it is rather than wrapped: an unrecoverable failure has to stay
         * recognisable to whatever decides to end the process on it.
         */
        if (isUnrecoverableError(lastError)) {
            throw lastError;
        }

        throw UnableToDispatchMessages.afterRetries(this.maxTries, lastError);
    }

    private async publishMessages(channel: ConfirmChannel, messages: MessagesFrom<Stream>): Promise<void> {
        for (const message of messages) {
            const routingKey = this.keyResolver(message);
            const exchange = typeof this.exchangeResolver === 'string'
                ? this.exchangeResolver
                : this.exchangeResolver(message);

            channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(message)), {
                persistent: true,
                contentType: 'application/json',
            });
        }

        await channel.waitForConfirms();
    }
}
