import { defineConfig } from 'vitest/config';

/**
 * Server test config (spec E-D2).
 *
 * Vitest rather than Jest because the client is already Vite: one runner and one
 * config idiom across both workspaces beats two. The server pays a small tax —
 * Vitest transpiles its TypeScript itself rather than reusing `ts-node` — which is
 * cheaper than maintaining a second runner and a second set of conventions.
 *
 * **No database, no server, no `.env`.** Every test here is a pure function.
 * That is a deliberate constraint, not a limitation of what got written: it keeps
 * CI under a minute and means a red run points at logic rather than at
 * infrastructure. The day an integration test earns its place, it goes in a
 * separate project with a service container and says so out loud.
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
            thresholds: { statements: 8, branches: 75, functions: 49, lines: 8 },
        },
        include: ['src/**/*.test.ts'],
        // Nothing here should reach the network or the filesystem, so a test that
        // hangs is a bug in the test. Fail fast rather than stalling CI.
        testTimeout: 5_000,
    },
});
