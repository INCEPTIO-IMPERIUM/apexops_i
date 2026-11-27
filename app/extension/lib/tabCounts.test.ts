import { beforeEach, describe, expect, it, vi } from 'vitest';
import { countEvents, eventsFromTab, forgetTab } from './tabCounts';

const A = 'https://a.example.test';
const B = 'https://b.example.test';

beforeEach(() => {
    const m = new Map<string, unknown>();
    vi.stubGlobal('browser', {
        storage: {
            session: {
                get: async (k: string) => (m.has(k) ? { [k]: structuredClone(m.get(k)) } : {}),
                set: async (items: Record<string, unknown>) => {
                    for (const [k, v] of Object.entries(items)) m.set(k, structuredClone(v));
                },
            },
        },
    });
});

describe('tab counts', () => {
    it('are per tab AND origin: a tab that moved to another bound site starts at 0 there', async () => {
        await countEvents(1, A, 3);
        expect(await eventsFromTab(1, A)).toBe(3);
        expect(await eventsFromTab(1, B)).toBe(0);
        await countEvents(1, B, 2);
        expect(await eventsFromTab(1, A)).toBe(3);
        expect(await eventsFromTab(1, B)).toBe(2);
    });

    it('do not mix tabs', async () => {
        await countEvents(1, A, 3);
        await countEvents(12, A, 5);
        expect(await eventsFromTab(1, A)).toBe(3);
        expect(await eventsFromTab(12, A)).toBe(5);
    });

    it('forgetting a tab (closed, or loading a new page) clears every origin for it and no other tab', async () => {
        await countEvents(1, A, 3);
        await countEvents(1, B, 2);
        await countEvents(12, A, 5);
        await forgetTab(1);
        expect(await eventsFromTab(1, A)).toBe(0);
        expect(await eventsFromTab(1, B)).toBe(0);
        // "1|" must not match "12|".
        expect(await eventsFromTab(12, A)).toBe(5);
    });

    it('concurrent counts are not lost', async () => {
        await Promise.all(Array.from({ length: 20 }, () => countEvents(1, A, 1)));
        expect(await eventsFromTab(1, A)).toBe(20);
    });
});
