import type {AnyMessageFrom, MessageConsumer, StreamDefinition} from '@deltic/messaging';

export class FailingMessageConsumer<Stream extends StreamDefinition> implements MessageConsumer<Stream> {
    private stagedFailures: {trigger: () => never, max: number}[] = [];

    constructor(
        private readonly consumer: MessageConsumer<Stream>,
    ) {
    }

    consume(message: AnyMessageFrom<Stream>): Promise<void> {
        const failure = this.stagedFailures.at(0);

        if (failure) {
            failure.max--;

            if (failure.max === 0) {
                this.stagedFailures.shift();
            }

            failure.trigger();
        }

        return this.consumer.consume(message);
    }

    stageFailure(trigger: () => never, max: number = Number.MAX_SAFE_INTEGER): void {
        this.stagedFailures.push({
            trigger,
            max,
        });
    }
}
