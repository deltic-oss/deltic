import {Pool} from 'pg';
import {AsyncPgPool, asyncPgPoolContextSlot, TransactionManagerUsingPg} from './index.js';
import {composeContextSlotsForTesting} from '@deltic/context';
import {
    transactionManagerContract,
    type TransactionLifecycleOperation,
    type TransactionManagerContractCase,
} from '../../transaction-manager/src/transaction-manager-contract.js';
import {pgTestCredentials} from '../../pg-credentials.js';

/**
 * Feeds the Postgres-backed manager into the contract every `TransactionManager`
 * has to satisfy. The contract records begin/commit/rollback on the collaborator
 * that performs them — here the pool — so the instrumented pool shadows those
 * three methods on the instance and forwards to the real implementations.
 */
describe('TransactionManagerUsingPg against the TransactionManager contract', () => {
    let pool: Pool;

    beforeAll(() => {
        pool = new Pool({...pgTestCredentials, max: 4, connectionTimeoutMillis: 2000});
    });

    afterAll(async () => {
        await pool.end();
    });

    const pgCase: TransactionManagerContractCase = {
        name: 'TransactionManagerUsingPg',
        managesTransactions: true,
        create() {
            // A store of its own per test, so transaction state cannot leak between
            // contract cases. The contract only ever works through transactions, which
            // release their connection on finalisation, so no flush is needed here.
            const context = composeContextSlotsForTesting([asyncPgPoolContextSlot]);
            const asyncPool = new AsyncPgPool(pool, {}, context);
            const lifecycle: TransactionLifecycleOperation[] = [];
            const rollbackCauses: unknown[] = [];
            let failNextRollback = false;

            const begin = asyncPool.begin.bind(asyncPool);
            const commit = asyncPool.commit.bind(asyncPool);
            const rollback = asyncPool.rollback.bind(asyncPool);

            asyncPool.begin = async (query?: string) => {
                lifecycle.push('begin');

                return begin(query);
            };
            asyncPool.commit = async connection => {
                lifecycle.push('commit');

                return commit(connection);
            };
            asyncPool.rollback = async (connection, error?: unknown) => {
                lifecycle.push('rollback');
                rollbackCauses.push(error);
                // The real rollback still runs, so a "failing" rollback leaves no open
                // transaction and no checked-out connection behind — the caller-visible
                // failure is what the contract is about.
                await rollback(connection, error);

                if (failNextRollback) {
                    failNextRollback = false;
                    throw new Error('the rollback failed');
                }
            };

            return {
                manager: new TransactionManagerUsingPg(asyncPool),
                lifecycle: () => lifecycle,
                rollbackCauses: () => rollbackCauses,
                failNextRollback: () => {
                    failNextRollback = true;
                },
            };
        },
    };

    transactionManagerContract([pgCase]);
});
