import {
    type DefineVersionedStream,
    SchemaVersionMessageDecorator,
    type UpcastersForVersionedStream,
    VersionedMessageConsumer,
} from './upcasting.js';
import {CollectingMessageConsumer} from './collecting-message-consumer.js';
import type {AnyMessageFrom} from './index.js';
import {
    type TestVersionedStream,
    type UserCreatedV3,
    testUpcasters,
} from './upcasting.stubs.js';

describe('Upcasting Edge Cases', () => {
    test('handles empty message arrays', () => {
        const decorator = new SchemaVersionMessageDecorator<TestVersionedStream>(testUpcasters);
        const result = decorator.decorate([]);
        expect(result).toEqual([]);
    });

    test('handles stream with no upcasters defined', async () => {
        // Define a stream type with only non-versioned messages
        type SimpleStream = DefineVersionedStream<{
            aggregateRootId: string;
            messages: {
                simple_event: {data: string};
            };
        }>;

        const emptyUpcasters = {} as UpcastersForVersionedStream<SimpleStream>;
        const collector = new CollectingMessageConsumer<SimpleStream>();
        const consumer = new VersionedMessageConsumer<SimpleStream>(emptyUpcasters, collector);

        const message: AnyMessageFrom<SimpleStream> = {
            type: 'simple_event',
            payload: {data: 'test'},
            headers: {},
        };

        await consumer.consume(message);

        expect(collector.messages).toHaveLength(1);
        expect(collector.messages[0].payload).toEqual({data: 'test'});
    });

    test('preserves message identity through upcasting', async () => {
        const collector = new CollectingMessageConsumer<TestVersionedStream>();
        const consumer = new VersionedMessageConsumer<TestVersionedStream>(testUpcasters, collector);

        const originalHeaders = {
            aggregate_root_id: 'agg-123',
            aggregate_root_version: 5,
            time_of_recording: '2024-01-01T00:00:00Z',
            time_of_recording_ms: 1704067200000,
            schema_version: 0,
            custom_header: 'preserved',
        };

        const message: AnyMessageFrom<TestVersionedStream> = {
            type: 'user_created',
            payload: {username: 'test'} as UserCreatedV3,
            headers: originalHeaders,
        };

        await consumer.consume(message);

        const consumed = collector.messages[0];
        expect(consumed.headers.aggregate_root_id).toBe('agg-123');
        expect(consumed.headers.aggregate_root_version).toBe(5);
        expect(consumed.headers.time_of_recording).toBe('2024-01-01T00:00:00Z');
        expect(consumed.headers.custom_header).toBe('preserved');
        expect(consumed.type).toBe('user_created');
    });
});
