import type {AggregateStream} from './index.js';
import type {MessageConsumer, MessageRepository, WhichMessageToProbe} from '@deltic/messaging';
import {WaitGroup} from '@deltic/wait-group';
import type {DynamicMutex} from '@deltic/mutex';
import type {OffsetRepository} from '@deltic/offset-tracking';

export interface AggregateVisitorOptions<Stream extends AggregateStream<Stream>> {
    readonly identifier: string,
    readonly batchSize: number,
    readonly whichMessage?: WhichMessageToProbe,
    readonly partitionSpecifier?: PartitionSpecifier,
    readonly progressReporter?: RebuildProgressReporter,
}

export class AggregateVisitor<Stream extends AggregateStream<Stream>> {
    private waiter = new WaitGroup();
    private waiting: boolean = false;
    private shouldContinue: boolean = true;
    private isStopping: boolean = false;
    private timer: NodeJS.Timeout | undefined = undefined;
    private wasLocked: boolean = false;
    private identifier: string;
    private batchSize: number;
    private partitionSpecifier: PartitionSpecifier;
    private whichMessage: WhichMessageToProbe;
    private progressReporter: RebuildProgressReporter | undefined;

    constructor(
        private mutex: DynamicMutex<number>,
        private messages: MessageRepository<Stream>,
        private offsets: OffsetRepository<Stream['aggregateRootId']>,
        private consumer: MessageConsumer<Stream>,
        options: AggregateVisitorOptions<Stream>,
    ) {
        this.partitionSpecifier = options.partitionSpecifier ?? staticPartitionSpecifier(0);
        this.identifier = options.identifier;
        this.batchSize = options.batchSize;
        this.whichMessage = options.whichMessage ?? 'last';
        this.progressReporter = options.progressReporter;
    }

    private async wait() {
        this.waiter.add();
        this.timer = setTimeout(() => {
            this.waiting = false;
            this.waiter.done();
        }, 1000);
        this.waiting = true;
        await this.waiter.wait();
    }

    async run(): Promise<void> {
        if (this.isStopping) {
            throw new Error('Cannot start running when busy stopping');
        }

        while (this.shouldContinue) {
            const partition = await this.partitionSpecifier.partition();
            const locked = await this.mutex.tryLock(partition);

            if (locked) {
                this.wasLocked = true;
            } else if (this.shouldContinue) {
                await this.wait();
                continue;
            }

            // The advisory lock holds a dedicated pooled client until released, so a throw or an early
            // return must still unlock — otherwise the lock is held for the process lifetime and the next
            // holder spins in the tryLock loop above forever.
            try {
                const offset = await this.offsets.retrieve(this.identifier);

                let processedAnyIdentifier = false;
                const ids = this.messages.paginateIds({
                    limit: this.batchSize,
                    afterId: offset,
                    whichMessage: this.whichMessage,
                });

                for await (const row of ids) {
                    if (!this.shouldContinue) {
                        return;
                    }

                    processedAnyIdentifier = true;
                    const {id, message} = row;
                    this.waiter.add();

                    await this.consumer.consume(message);
                    await this.offsets.store(this.identifier, id);

                    this.waiter.done();
                }

                if (!processedAnyIdentifier) {
                    this.shouldContinue = false;
                } else {
                    await this.progressReporter?.reportBatchDone();
                }
            } finally {
                if (this.wasLocked) {
                    await this.mutex.unlock(partition);
                }
            }
        }
    }

    async stop(): Promise<void> {
        this.shouldContinue = false;

        if (this.waiting) {
            clearTimeout(this.timer);
            this.waiter.done();
        }
        await this.waiter.wait();
    }
}

export interface PartitionSpecifier {
    partition(): Promise<number>;
}

export function staticPartitionSpecifier(partition: number = 0): PartitionSpecifier {
    const promise = Promise.resolve(partition);

    return {partition: () => promise};
}

export interface RebuildProgressReporter {
    reportStart(): Promise<void>,
    reportBatchDone(): Promise<void>,
    reportAllDone(): Promise<void>,
}
