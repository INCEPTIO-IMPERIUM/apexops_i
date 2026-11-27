import { defineConfig } from 'vitest/config';

/**
 * Pure-function suites, no DOM: the SDK core takes its host (window, document,
 * console) as an argument precisely so it can be tested with fakes here.
 */
export default defineConfig({
    test: {
        environment: 'node',
        coverage: {
            // Every source file, not only the ones a test happens to import.
            include: ['src/**/*.ts'],
            exclude: ['**/*.test.*', '**/*.d.ts'],
            reporter: ['text-summary', 'json-summary', 'lcov'],
            // A floor just under what was measured when it was set, so coverage
            // cannot quietly fall. Raise it as tests arrive; never lower it to pass.
            thresholds: { statements: 68, branches: 80, functions: 81, lines: 68 },
        },
        include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
        testTimeout: 10_000,
    },
});
