import {defineConfig} from 'vitest/config';
import {join} from 'node:path';

export default defineConfig({
    resolve: {
        tsconfigPaths: true,
        alias: [
            {
                find: '@deltic/mutex/static-memory',
                replacement: join(new URL(import.meta.url).pathname, '../packages/mutex/src/static-memory.ts'),
            },
            {
                find: /^@\/(.*)$/,
                replacement: join(new URL(import.meta.url).pathname, '../packages', '$1', 'src/index.ts'),
            },
        ],
    },
    test: {
        retry: 3,
        logHeapUsage: true,
        testTimeout: 10_000,
        include: ['packages/*/src/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
        globals: true,
        clearMocks: false,
        env: {
            POSTGRES_PORT: process.env.POSTGRES_PORT ?? '35432',
        },
        // projects: [
        //     // {
        //     //     test: {
        //     //         name: 'Context',
        //     //         isolate: true,
        //     //         include: ['packages/context/src/**/*.test.ts'],
        //     //     },
        //     //     extends: true,
        //     // },
        //     {
        //         test: {
        //             name: 'Other',
        //             isolate: false,
        //             // exclude: ['packages/context/src/**/*.test.ts'],
        //             // include: ['packages/*/src/**/*.test.ts'],
        //         },
        //         extends: true,
        //     },
        // ],
        // setupFiles: ['dotenv/config'],

        // pool: 'threads',
        isolate: false,
        // profiling
        // pool: 'forks',
        // poolOptions: {
        //     forks: {
        //         execArgv: [
        //             '--cpu-prof',
        //             '--cpu-prof-dir=test-runner-profile',
        //             // '--heap-prof',
        //             // '--heap-prof-dir=test-runner-profile'
        //         ],
        //
        //         // To generate a single profile
        //         singleFork: true,
        //     },
        // },
    },
});
