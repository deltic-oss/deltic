import {GlobalClock, type TestClock} from '@deltic/clock';
import type {AnyInputForService, InputForServiceOfType, Service, ServiceStructure} from '@deltic/service-dispatcher';
import {NoopTransactionManager} from '@deltic/transaction-manager';
import {
    type AggregateRepository,
    type AggregateRootFactory,
    type AggregateStream,
    EventSourcedAggregateRepository,
} from './index.js';
import {MessageRepositoryUsingMemory} from '@deltic/messaging/message-repository-using-memory';
import {MessageDecoratorChain} from '@deltic/messaging/message-decorator-chain';
import {createMessageDecorator, messageWithHeaders} from '@deltic/messaging/helpers';
import type {
    AnyMessageFrom,
    AnyMessageTypeFromStream,
    Message,
    MessageDecorator,
    MessageHeaders,
    MessagesFrom,
} from '@deltic/messaging';

type WhenHandler<Stream extends AggregateStream<Stream>> = (context: {
    aggregateRoot: Stream['aggregateRoot'];
    repository: AggregateRepository<Stream>;
}) => Promise<void>;

export type ServiceFactory<
    Stream extends AggregateStream<Stream>,
    ServiceDefinition extends ServiceStructure<ServiceDefinition>,
> = (context: {
    repository: AggregateRepository<Stream>;
    messageRepository: MessageRepositoryUsingMemory<Stream>;
}) => Service<ServiceDefinition>;

export function createTestTooling<
    Stream extends AggregateStream<Stream>,
    ServiceDefinition extends ServiceStructure<ServiceDefinition> = {},
>(
    id: Stream['aggregateRootId'],
    factory: AggregateRootFactory<Stream>,
    serviceFactory?: ServiceFactory<Stream, ServiceDefinition>,
    messageRepository: MessageRepositoryUsingMemory<Stream> = new MessageRepositoryUsingMemory<Stream>(),
    testClock: TestClock = GlobalClock as TestClock,
    additionalMessageDecorators: MessageDecorator<Stream>[] = [],
) {
    const versions: Map<Stream['aggregateRootId'] | undefined, number> = new Map();
    const repository = new EventSourcedAggregateRepository(
        factory,
        messageRepository,
        undefined,
        new MessageDecoratorChain([
            // check for possible data-loss in decorator
            createMessageDecorator(message => {
                expect(message).toEqual(JSON.parse(JSON.stringify(message)));

                return message;
            }),
            ...additionalMessageDecorators,
        ]),
        new NoopTransactionManager(),
    );
    const error: any | undefined = undefined;
    const bus = serviceFactory
        ? serviceFactory({
              messageRepository,
              repository,
          })
        : undefined;

    afterEach(() => {
        messageRepository.clear();
        versions.clear();
        if (error) {
            throw error;
        }

        expectedError = undefined;
    });

    const createMessage = <T extends AnyMessageTypeFromStream<Stream>>(
        type: T,
        payload: Stream['messages'][T],
        headers: MessageHeaders = {},
    ): AnyMessageFrom<Stream> => ({headers, type, payload});

    const given = (...messages: MessagesFrom<Stream>) => {
        messages = messages.map(m => {
            const version = (versions.get(m.headers['aggregate_root_id']) ?? 0) + 1;
            versions.set(m.headers['aggregate_root_id'], version);

            return messageWithHeaders(m, {
                aggregate_root_version: version,
                time_of_recording_ms: m.headers['time_of_recording_ms'] ?? testClock.now(),
            });
        });
        messageRepository.persistSync(id, messages);
        messageRepository.clearLastCommit();
    };

    type When<T extends keyof ServiceDefinition = keyof ServiceDefinition> =
        | ((
            input: InputForServiceOfType<ServiceDefinition, T>
        ) =>  Promise<ServiceDefinition[T]['response']>)
        | ((
            type: T,
            payload: ServiceDefinition[T]['payload'],
        ) =>  Promise<ServiceDefinition[T]['response']>)

    const when: When = async (
        type,
        payload
    ) => {
        const input = typeof type === 'string'
            ? {type, payload}
            : type as unknown as AnyInputForService<ServiceDefinition>;

        if (!bus) {
            throw new Error('Invalid tools setup, using when without setting up a service.');
        }

        // A command that records nothing never reaches the message repository, so the events of an
        // earlier action would otherwise still be reported as emitted.
        messageRepository.clearLastCommit();

        try {
            const result = await bus.handle(input);

            if (expectedError !== undefined) {
                const unthrownError = expectedError;
                expectedError = undefined;

                const msg = unthrownError instanceof Error ? unthrownError.message : 'Unknown type of error';

                throw new Error(`Expected error to be thrown but did not occur: ${msg}`, {
                    cause: unthrownError,
                });
            }

            return result;
        } catch (e) {
            if (expectedError !== undefined) {
                if (typeof expectedError === 'function') {
                    expect(e).toBeInstanceOf(expectedError);
                } else {
                    expect(e).toEqual(expectedError);
                }
                expectedError = undefined;
            } else {
                throw e;
            }
        }
    };

    const retrieveEntity = async () => await repository.retrieve(id);

    const whenAggregate = async (handle: WhenHandler<Stream>) => {
        messageRepository.clearLastCommit();
        const aggregateRoot = await repository.retrieve(id);
        try {
            await handle({aggregateRoot, repository});

            if (expectedError !== undefined) {
                const unthrownError = expectedError;
                expectedError = undefined;

                const msg = unthrownError instanceof Error ? unthrownError.message : 'Unknown type of error';

                throw new Error(`Expected error to be thrown but did not occur: ${msg}`, {
                    cause: unthrownError,
                });
            }
        } catch (e) {
            if (expectedError) {
                if (typeof expectedError === 'function') {
                    expect(e).toBeInstanceOf(expectedError);
                } else {
                    expect(e).toEqual(expectedError);
                }
                expectedError = undefined;
            } else {
                throw e;
            }
        } finally {
            await repository.persist(aggregateRoot);
        }
    };

    let expectedError: any = undefined;
    const expectError = (error: any) => (expectedError = error);

    const removeHeaders = <M extends Message<any, any>>(message: M): M => ({
        ...message,
        headers: {},
    });
    const emittedEvents = () => messageRepository.lastCommit.map(removeHeaders);
    const emittedEventsWithHeaders = () => messageRepository.lastCommit;
    const then = (...expected: MessagesFrom<Stream>) => expect(emittedEvents()).toEqual(expected.map(removeHeaders));
    const expectNoEvents = () => expect(emittedEvents()).toHaveLength(0);

    type TestTooling = {
        given: typeof given;
        whenAggregate: typeof whenAggregate;
        id: typeof id;
        when: typeof when;
        createMessage: typeof createMessage;
        expectError: typeof expectError;
        emittedEvents: typeof emittedEvents;
        emittedEventsWithHeaders: typeof emittedEventsWithHeaders;
        then: typeof then;
        retrieveEntity: typeof retrieveEntity;
        testClock: TestClock;
        expectNoEvents: typeof expectNoEvents;
    };

    const tools: TestTooling = {
        expectNoEvents,
        given,
        whenAggregate,
        then,
        retrieveEntity,
        id,
        when,
        createMessage,
        emittedEvents,
        emittedEventsWithHeaders,
        expectError,
        testClock,
    };

    return {repository, bus, ...tools};
}
