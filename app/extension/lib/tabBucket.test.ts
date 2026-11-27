import { describe, expect, it } from 'vitest';
import { BURST, createTabBucket, PER_SECOND } from './tabBucket';

describe('tab bucket', () => {
    it('lets a burst through, then the sustained rate, and counts the rest', () => {
        const b = createTabBucket();
        const t0 = 1_000_000;
        let ok = 0;
        // 1,000 batches inside one second, as a flooding page would send them.
        for (let i = 0; i < 1000; i++) if (b.take(1, t0 + i)) ok++;
        expect(ok).toBeGreaterThanOrEqual(BURST);
        expect(ok).toBeLessThanOrEqual(BURST + PER_SECOND);
        expect(b.dropped(1)).toBe(1000 - ok);
    });

    it('refills over time', () => {
        const b = createTabBucket();
        for (let i = 0; i < BURST; i++) b.take(1, 0);
        expect(b.take(1, 0)).toBe(false);
        expect(b.take(1, 1000)).toBe(true);
    });

    it('one tab flooding does not spend another tab\'s allowance', () => {
        const b = createTabBucket();
        for (let i = 0; i < 500; i++) b.take(1, 0);
        expect(b.take(2, 0)).toBe(true);
    });

    it('forgetting a tab resets it', () => {
        const b = createTabBucket();
        for (let i = 0; i < 100; i++) b.take(1, 0);
        b.forget(1);
        expect(b.dropped(1)).toBe(0);
        expect(b.take(1, 0)).toBe(true);
    });
});
