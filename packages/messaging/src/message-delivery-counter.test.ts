import {MessageDeliveryCounterUsingMemory} from './message-delivery-counter.js';

describe('MessageDeliveryCounterUsingMemory', () => {
    test('first increment returns 1', async () => {
        const counter = new MessageDeliveryCounterUsingMemory<string>();

        expect(await counter.increment('a')).toEqual(1);
    });

    test('subsequent increments increase the count', async () => {
        const counter = new MessageDeliveryCounterUsingMemory<string>();

        await counter.increment('a');
        await counter.increment('a');

        expect(await counter.increment('a')).toEqual(3);
    });

    test('different keys are tracked independently', async () => {
        const counter = new MessageDeliveryCounterUsingMemory<string>();

        await counter.increment('a');
        await counter.increment('a');
        await counter.increment('b');

        expect(await counter.increment('a')).toEqual(3);
        expect(await counter.increment('b')).toEqual(2);
    });

    test('a forgotten key starts counting over', async () => {
        const counter = new MessageDeliveryCounterUsingMemory<string>();

        await counter.increment('a');
        await counter.increment('a');
        await counter.forget('a');

        expect(await counter.increment('a')).toEqual(1);
    });
});
