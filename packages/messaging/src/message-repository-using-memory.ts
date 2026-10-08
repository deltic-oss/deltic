import type {
    AggregateIdWithStreamOffset,
    AnyMessageFrom,
    IdPaginationOptions,
    MessageRepository,
    MessagesFrom,
    StreamDefinition,
} from './index.js';
import {ValueReadWriterUsingMemory, type ValueReader} from '@deltic/context';

import {messageWithHeaders} from './helpers.js';

export class MessageRepositoryUsingMemory<Stream extends StreamDefinition> implements MessageRepository<Stream> {
    private messages: Map<string | number | undefined, Map<Stream['aggregateRootId'], MessagesFrom<Stream>>> =
        new Map();
    private _lastCommit: MessagesFrom<Stream> = [];
    private incrementalId: number = 0;

    constructor(
        private readonly tenantContext: ValueReader<Stream['aggregateRootId']> = new ValueReadWriterUsingMemory(),
    ) {}

    async persist(id: Stream['aggregateRootId'], messages: MessagesFrom<Stream>): Promise<void> {
        this.persistSync(id, messages);
    }

    persistSync(id: Stream['aggregateRootId'], messages: MessagesFrom<Stream>): void {
        const tenantId = this.tenantContext.resolve();
        messages = messages.map(m =>
            messageWithHeaders(m, {
                aggregate_root_id: id,
                tenant_id: tenantId,
                stream_offset: ++this.incrementalId,
            }),
        );
        const list = (this.messages.get(tenantId)?.get(id) || []).concat(messages);
        this._lastCommit = messages;

        if (!this.messages.has(tenantId)) {
            this.messages.set(tenantId, new Map());
        }

        this.messages.get(tenantId)!.set(id, list);
    }

    async *retrieveAllAfterVersion(
        id: Stream['aggregateRootId'],
        version: number,
    ): AsyncGenerator<AnyMessageFrom<Stream>, any, unknown> {
        for await (const m of this.retrieveAllForAggregate(id)) {
            if (Number(m.headers['aggregate_root_version']) > version) {
                yield m;
            }
        }
    }

    retrieveAllUntilVersion(
        id: Stream['aggregateRootId'],
        version: number,
    ): AsyncGenerator<AnyMessageFrom<Stream>, any, unknown> {
        return this.retrieveBetweenVersions(id, 0, version);
    }

    async *retrieveBetweenVersions(
        id: Stream['aggregateRootId'],
        after: number,
        before: number,
    ): AsyncGenerator<AnyMessageFrom<Stream>, any, unknown> {
        for await (const m of this.retrieveAllForAggregate(id)) {
            const version = Number(m.headers['aggregate_root_version']);

            if (version > after && version < before) {
                yield m;
            }
        }
    }

    async *retrieveAllForAggregate(id: Stream['aggregateRootId']): AsyncGenerator<AnyMessageFrom<Stream>> {
        const tenantId = this.tenantContext.resolve();

        for (const m of this.messages.get(tenantId)?.get(id) || []) {
            yield m;
        }
    }

    async *paginateIds(options: IdPaginationOptions<Stream>): AsyncGenerator<AggregateIdWithStreamOffset<Stream>> {
        const {limit, afterId, whichMessage = 'last'} = options;

        if (limit <= 0) {
            return;
        }

        let left = limit;
        let shouldYield = afterId === undefined;
        const collected = new Set<Stream['aggregateRootId']>();

        for (const group of this.messages.values()) {
            for (const [aggregateId, messages] of group) {
                if (collected.has(aggregateId) || messages.length === 0) {
                    continue;
                }
                collected.add(aggregateId);

                if (!shouldYield) {
                    if (aggregateId === afterId) {
                        shouldYield = true;
                    }

                    continue;
                }

                const message = messages.at(whichMessage === 'first' ? 0 : -1)!;

                yield {
                    id: aggregateId,
                    version: message.headers['aggregate_root_version'] ?? 0,
                    message,
                };
                left--;

                if (left === 0) {
                    return;
                }
            }
        }
    }

    clear(): void {
        this.messages.clear();
        this._lastCommit = [];
    }

    get lastCommit(): MessagesFrom<Stream> {
        return this._lastCommit;
    }

    clearLastCommit(): void {
        this._lastCommit = [];
    }
}
