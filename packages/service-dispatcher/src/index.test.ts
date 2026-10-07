import {InputNotSupported, ServiceDispatcher, type ServiceMiddleware} from './index.js';

interface NumberToNumber {
    value: number;
}

interface UppercaseResponse {
    value: string;
}

interface ExampleServiceDispatcher {
    number_to_number: {
        payload: NumberToNumber;
        response: number;
    };
    string_to_string: {
        payload: string;
        response: UppercaseResponse;
    };
}

describe('@deltic/service-dispatcher', () => {
    let lastType: any = undefined;
    let callOrder: string[];
    const exampleServiceDispatcher = new ServiceDispatcher<ExampleServiceDispatcher>(
        {
            number_to_number: async (input: NumberToNumber): Promise<number> => input.value,
            string_to_string: async (input: string): Promise<UppercaseResponse> => ({
                value: input.toUpperCase(),
            }),
        },
        [
            (input, next) => {
                lastType = input.type;
                callOrder.push('first');

                return next(input);
            },
            async (input, next) => {
                const response = await next(input);

                callOrder.push('last');

                return response;
            },
            (input, next) => {
                lastType = input.type;
                callOrder.push('second');

                return next(input);
            },
        ],
    );

    beforeEach(() => {
        lastType = undefined;
        callOrder = [];
    });

    test('a bus forwards to the correct handler', async () => {
        const n = await exampleServiceDispatcher.handle({type: 'number_to_number', payload: {value: 10}});
        expect(lastType).toBe('number_to_number');
        expect(n).toEqual(10);
        const s = await exampleServiceDispatcher.handle({type: 'string_to_string', payload: 'frank'});
        expect(s).toEqual({value: 'FRANK'});
        expect(lastType).toBe('string_to_string');
    });

    test('middleware is invoked during handling', async () => {
        await exampleServiceDispatcher.handle({type: 'number_to_number', payload: {value: 10}});
        expect(lastType).toBe('number_to_number');
        await exampleServiceDispatcher.handle({type: 'string_to_string', payload: 'frank'});
        expect(lastType).toBe('string_to_string');
    });

    test('middleware is invoked in order of declaratin', async () => {
        await exampleServiceDispatcher.handle({type: 'number_to_number', payload: {value: 10}});

        expect(callOrder).toEqual(['first', 'second', 'last']);
    });

    test('a bus throws when input is not supported', async () => {
        await expect(exampleServiceDispatcher.handle({type: 'unknown', payload: true} as any)).rejects.toThrow();
    });
});

interface PaymentService {
    register_payment: {
        payload: {reference: string; amount: number};
        response: {reference: string};
    };
    refund_payment: {
        payload: {reference: string};
        response: {refunded: boolean};
    };
}

describe('dispatching unsupported input', () => {
    const dispatcher = new ServiceDispatcher<PaymentService>({
        register_payment: async payload => ({reference: payload.reference}),
        refund_payment: async () => ({refunded: true}),
    });

    test('rejects with a typed error naming the input type', async () => {
        const dispatching = dispatcher.handle({type: 'cancel_payment', payload: {}} as never);

        await expect(dispatching).rejects.toThrow(InputNotSupported);
        await expect(dispatching).rejects.toThrow('Unable to handle input of type: cancel_payment');
    });

    test('rejects an input type that is only present on the prototype of the handler map', async () => {
        for (const type of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
            await expect(
                dispatcher.handle({type, payload: {reference: 'ref-1', amount: 100}} as never),
            ).rejects.toThrow(InputNotSupported);
        }
    });
});

describe('dispatching through middleware', () => {
    let handled: string[];

    const handlers = {
        register_payment: async (payload: PaymentService['register_payment']['payload']) => {
            handled.push(`register_payment:${payload.reference}`);

            return {reference: payload.reference};
        },
        refund_payment: async (payload: PaymentService['refund_payment']['payload']) => {
            handled.push(`refund_payment:${payload.reference}`);

            return {refunded: true};
        },
    };

    beforeEach(() => {
        handled = [];
    });

    test('a middleware that does not call next short-circuits the handler', async () => {
        const dispatcher = new ServiceDispatcher<PaymentService>(handlers, [
            async () => ({reference: 'from-cache'}),
        ]);

        const response = await dispatcher.handle({
            type: 'register_payment',
            payload: {reference: 'ref-1', amount: 100},
        });

        expect(response).toEqual({reference: 'from-cache'});
        expect(handled).toEqual([]);
    });

    test('a middleware that throws prevents the handler from running', async () => {
        const failure = new Error('not authorised');
        const dispatcher = new ServiceDispatcher<PaymentService>(handlers, [
            async () => {
                throw failure;
            },
        ]);

        await expect(
            dispatcher.handle({type: 'register_payment', payload: {reference: 'ref-1', amount: 100}}),
        ).rejects.toThrow(failure);
        expect(handled).toEqual([]);
    });

    test('an error from the handler travels back up through the middleware chain', async () => {
        const failure = new Error('payment declined');
        const observed: string[] = [];
        const observing: ServiceMiddleware<PaymentService> = async (input, next) => {
            try {
                return await next(input);
            } catch (error) {
                observed.push((error as Error).message);
                throw error;
            }
        };
        const dispatcher = new ServiceDispatcher<PaymentService>(
            {
                ...handlers,
                register_payment: async () => {
                    throw failure;
                },
            },
            [observing, observing],
        );

        await expect(
            dispatcher.handle({type: 'register_payment', payload: {reference: 'ref-1', amount: 100}}),
        ).rejects.toThrow(failure);
        expect(observed).toEqual(['payment declined', 'payment declined']);
    });

    test('a middleware can recover from a failing handler', async () => {
        const recovering: ServiceMiddleware<PaymentService> = async (input, next) => {
            try {
                return await next(input);
            } catch {
                return {reference: 'compensated'};
            }
        };
        const dispatcher = new ServiceDispatcher<PaymentService>(
            {
                ...handlers,
                register_payment: async () => {
                    throw new Error('payment declined');
                },
            },
            [recovering],
        );

        const response = await dispatcher.handle({
            type: 'register_payment',
            payload: {reference: 'ref-1', amount: 100},
        });

        expect(response).toEqual({reference: 'compensated'});
    });

    test('the handler runs once per invocation of next', async () => {
        const dispatcher = new ServiceDispatcher<PaymentService>(handlers, [
            async (input, next) => {
                await next(input);

                return next(input);
            },
        ]);

        await dispatcher.handle({type: 'register_payment', payload: {reference: 'ref-1', amount: 100}});

        expect(handled).toEqual(['register_payment:ref-1', 'register_payment:ref-1']);
    });

    test('a middleware can dispatch a follow-up command through the same dispatcher', async () => {
        const compensating: ServiceMiddleware<PaymentService> = async (input, next) => {
            const response = await next(input);

            if (input.type === 'register_payment') {
                await dispatcher.handle({type: 'refund_payment', payload: {reference: 'ref-1'}});
            }

            return response;
        };
        const dispatcher: ServiceDispatcher<PaymentService> = new ServiceDispatcher<PaymentService>(handlers, [
            compensating,
        ]);

        const response = await dispatcher.handle({
            type: 'register_payment',
            payload: {reference: 'ref-1', amount: 100},
        });

        expect(response).toEqual({reference: 'ref-1'});
        expect(handled).toEqual(['register_payment:ref-1', 'refund_payment:ref-1']);
    });

});
