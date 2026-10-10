import type {AnyMessageFrom, MessageConsumer, StreamDefinition} from './index.js';
import {WaitGroup} from '@deltic/wait-group';

export class WaitingMessageConsumer<Stream extends StreamDefinition> implements MessageConsumer<Stream> {
    private waitGroup = new WaitGroup();

    constructor(
        private consumer: MessageConsumer<Stream>,
    ) {
    }

    async consume(message: AnyMessageFrom<Stream>): Promise<void> {
        await this.consumer.consume(message);
        this.waitGroup.done();
    }

    expectDeliveryAmount(amount: number = 1): void {
        this.waitGroup.add(amount);
    }

    wait(timeout?: number): Promise<void> {
        return this.waitGroup.wait(timeout);
    }
}
