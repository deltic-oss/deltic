import {CollectingMessageDispatcher} from './collecting-message-dispatcher.js';
import {
    createMessage,
    createMessageConsumer,
    createMessageDecorator,
    createMessageDispatcher,
    messageWithHeader,
    messageWithHeaders,
    timeOfRecordingFromMessage,
    withoutHeaders,
} from './helpers.js';
import {CollectingMessageConsumer} from './collecting-message-consumer.js';
import type {AnyMessageFrom, Message, StreamDefinition} from '@deltic/messaging';

interface ExampleStream extends StreamDefinition {
    messages: {
        example: string;
    };
}

const exampleMessage: AnyMessageFrom<ExampleStream> = {
    headers: {},
    type: 'example',
    payload: 'value',
};

describe('Messaging helper functions', () => {
    test('createMessageDispatcher creates a producer from a function', async () => {
        const actualProducer = new CollectingMessageDispatcher<ExampleStream>();
        const producer = createMessageDispatcher(
            actualProducer.send.bind(actualProducer) as typeof actualProducer.send,
        );
        const message: AnyMessageFrom<ExampleStream> = {
            payload: 'lol',
            headers: {},
            type: 'example',
        };
        await producer.send(message);
        expect(actualProducer.producedMessages()).toContain(message);
    });

    test('createMessageConsumer creates a consumer from a function', async () => {
        const actualConsumer = new CollectingMessageConsumer<ExampleStream>();
        const producer = createMessageConsumer<ExampleStream>(actualConsumer.consume.bind(actualConsumer));
        const message: AnyMessageFrom<ExampleStream> = {
            payload: 'lol',
            headers: {},
            type: 'example',
        };
        await producer.consume(message);
        expect(actualConsumer.messages).toContain(message);
    });

    describe('messageWithHeader', () => {
        test('messageWithHeader adds headers to a message', () => {
            const header = {key: 'something', value: 'value'};
            const message = messageWithHeader(exampleMessage, header);

            expect(message.headers?.something).toEqual('value');
        });

        test('containsMessage detects when messages are contains in a message array', () => {
            const messages: object[] = [exampleMessage];
            const otherMessage: Message<'type', 'other'> = {
                headers: {},
                type: 'type',
                payload: 'other',
            };
            expect(messages.includes(otherMessage)).toBe(false);
            expect(messages.includes(exampleMessage)).toBe(true);
        });

        test('it does not modify the message it decorates', () => {
            const original = createMessage<ExampleStream>('example', 'value', {event_id: 'event-1'});

            messageWithHeader(original, {key: 'added', value: 1});
            messageWithHeaders(original, {also_added: 2});

            expect(original.headers).toEqual({event_id: 'event-1'});
        });

        test('later headers win over the ones already on the message', () => {
            const original = createMessage<ExampleStream>('example', 'value', {event_id: 'event-1'});

            expect(messageWithHeaders(original, {event_id: 'event-2'}).headers['event_id']).toEqual('event-2');
        });
    });

    test('withoutHeaders keeps the type and payload and drops every header', () => {
        const message = createMessage<ExampleStream>('example', 'value', {event_id: 'event-1'});

        expect(withoutHeaders(message)).toEqual({type: 'example', payload: 'value', headers: {}});
    });

    test('createMessageDecorator applies the function to every message in the batch', () => {
        const decorator = createMessageDecorator<ExampleStream>(
            message => messageWithHeader(message, {key: 'decorated', value: true}),
        );

        const decorated = decorator.decorate([
            createMessage<ExampleStream>('example', 'one'),
            createMessage<ExampleStream>('example', 'two'),
        ]);

        expect(decorated.map(m => m.headers['decorated'])).toEqual([true, true]);
    });

    describe('timeOfRecording', () => {
        test('it prefers the millisecond header', () => {
            const message = createMessage<ExampleStream>('example', 'value', {
                time_of_recording: '2024-01-01T00:00:00.000Z',
                time_of_recording_ms: 1234,
            });

            expect(timeOfRecordingFromMessage(message)).toEqual(1234);
        });

        test('it falls back to the formatted header', () => {
            const message = createMessage<ExampleStream>('example', 'value', {
                time_of_recording: '2024-01-01T00:00:00.000Z',
            });

            expect(timeOfRecordingFromMessage(message)).toEqual(Date.parse('2024-01-01T00:00:00.000Z'));
        });

        /**
         * Messages that were never decorated with a recording time have no time to
         * report. Callers that use this for lag measurements need to know they get NaN
         * rather than a zero or the current time.
         */
        test('a message without recording headers reports NaN', () => {
            expect(timeOfRecordingFromMessage(createMessage<ExampleStream>('example', 'value'))).toBeNaN();
        });
    });
});
