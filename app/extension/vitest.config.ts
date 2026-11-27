import { defineConfig } from 'vitest/config';

/**
 * Unit suites for the extension's pure parts — the event sanitiser and the
 * ingest queue. Anything that needs a real browser (registration, the worker,
 * content scripts in a page) is proven end to end instead:
 * .agents/harness/browser-extension/checks/p3-extension.mjs.
 */
export default defineConfig({
    test: {
        environment: 'node',
        coverage: {
            // Every source file, not only the ones a test happens to import.
            include: ['lib/**/*.ts'],
            exclude: ['**/*.test.*', '**/*.d.ts'],
            reporter: ['text-summary', 'json-summary', 'lcov'],
            // A floor just under what was measured when it was set, so coverage
            // cannot quietly fall. Raise it as tests arrive; never lower it to pass.
            thresholds: { statements: 79, branches: 87, functions: 83, lines: 79 },
        },
        include: ['lib/**/*.test.ts'],
        testTimeout: 5_000,
    },
});
