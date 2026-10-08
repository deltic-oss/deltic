import type {AnyMessageFrom, MessageConsumer, StreamDefinition} from './index.js';
import type {ContextRunner} from '@deltic/context';

/**
 * Runs every message in a context scope of its own, with the tenant from the message's `tenant_id`
 * header. Messages consumed at the same time keep their own tenant only when the context's store gives
 * every scope its own value, as `AsyncLocalStorage` does.
 */
export class TenantScopingMessageConsumer<Stream extends StreamDefinition> implements MessageConsumer<Stream> {
    constructor(
        private readonly context: ContextRunner<{tenant_id: string}>,
        private readonly consumer: MessageConsumer<Stream>,
    ) {}

    async consume(message: AnyMessageFrom<Stream>): Promise<void> {
        const tenantId = message.headers['tenant_id'] as string | undefined;

        // Provided even when undefined, so a message without a tenant never runs as the surrounding one.
        await this.context.run(() => this.consumer.consume(message), {tenant_id: tenantId});
    }
}
