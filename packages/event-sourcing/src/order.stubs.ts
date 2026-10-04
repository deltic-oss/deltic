import type {AnyMessageFrom} from '@deltic/messaging';
import type {AggregateRootOptions} from './index.js';
import type {
    AggregateRootWithSnapshotting,
    AggregateStreamWithSnapshotting,
    Snapshot,
} from './snapshotting.js';
import {AggregateRootUsingReducerFunc} from './using-reducer-func.js';

/**
 * A realistic ordering domain, used to exercise the repositories against every
 * message-repository and snapshot-repository implementation.
 */
export interface OrderState {
    customer: string | undefined;
    total: number;
    items: Record<string, number>;
    shipped: boolean;
}

export interface OrderStream extends AggregateStreamWithSnapshotting<OrderStream> {
    aggregateRootId: string;
    aggregateRoot: Order;
    messages: {
        order_was_placed: {customer: string; total: number};
        item_was_added: {sku: string; quantity: number};
        order_was_shipped: {carrier: string; tracking_number: string};
        /**
         * A payload that is not safe to round-trip through JSON. Modelling a payload
         * like this is a mistake a consumer can easily make, because the type system
         * happily accepts it.
         */
        delivery_was_scheduled: {scheduled_for: number};
    };
    snapshot: OrderState;
}

export const emptyOrderState = (): OrderState => ({
    customer: undefined,
    total: 0,
    items: {},
    shipped: false,
});

export class OrderWasAlreadyShipped extends Error {
    constructor() {
        super('The order was already shipped.');
    }
}

export class Order
    extends AggregateRootUsingReducerFunc<OrderStream, OrderState>
    implements AggregateRootWithSnapshotting<OrderStream>
{
    constructor(
        aggregateRootId: string,
        initialState: OrderState = emptyOrderState(),
        options: AggregateRootOptions = {},
    ) {
        super(aggregateRootId, initialState, options);
    }

    static place(id: string, customer: string, total: number): Order {
        const order = new Order(id);
        order.recordThat('order_was_placed', {customer, total});

        return order;
    }

    placeFor(customer: string, total: number): void {
        this.recordThat('order_was_placed', {customer, total});
    }

    addItem(sku: string, quantity: number): void {
        if (this.state.shipped) {
            throw new OrderWasAlreadyShipped();
        }

        this.recordThat('item_was_added', {sku, quantity});
    }

    scheduleDelivery(scheduledFor: Date): void {
        this.recordThat('delivery_was_scheduled', {scheduled_for: scheduledFor.getTime()});
    }

    ship(carrier: string, trackingNumber: string): void {
        if (this.state.shipped) {
            throw new OrderWasAlreadyShipped();
        }

        this.recordThat('order_was_shipped', {carrier, tracking_number: trackingNumber});
    }

    currentState(): OrderState {
        return this.state;
    }

    createSnapshot(): OrderState {
        return this.state;
    }

    static async reconstituteFromEvents(
        id: string,
        messages: AsyncGenerator<AnyMessageFrom<OrderStream>>,
    ): Promise<Order> {
        return new Order(id).applyAll(messages);
    }

    static async reconstituteFromSnapshot(
        id: string,
        snapshot: Snapshot<OrderStream>,
        messages?: AsyncGenerator<AnyMessageFrom<OrderStream>>,
    ): Promise<Order> {
        const order = new Order(id, snapshot.state);
        order.aggregateRootVersionNumber = snapshot.version;

        for await (const message of messages ?? []) {
            order.apply(message);
        }

        return order;
    }

    protected reduce(state: OrderState, message: AnyMessageFrom<OrderStream>): OrderState {
        switch (message.type) {
            case 'order_was_placed':
                return {...state, customer: message.payload.customer, total: message.payload.total};
            case 'item_was_added':
                return {
                    ...state,
                    items: {
                        ...state.items,
                        [message.payload.sku]: (state.items[message.payload.sku] ?? 0) + message.payload.quantity,
                    },
                };
            case 'order_was_shipped':
                return {...state, shipped: true};
            default:
                return state;
        }
    }
}
