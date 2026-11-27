/**
 * How many capture batches each tab may hand the worker (hardening H3, S1/S2).
 *
 * Any script on a page can dispatch the capture event, as often as it likes,
 * and each one used to cost the worker storage reads and writes before it
 * could even be refused. A token bucket per tab, in memory, decides first:
 * 20 batches at once, 5 a second after that. The page-side capture batches on
 * its own, so a real page sits far below this; only a flood is cut.
 *
 * Dropped batches are counted here, in memory, and never written: writing the
 * count would cost what the bucket exists to save.
 */

export const BURST = 20;
export const PER_SECOND = 5;

interface Bucket {
    tokens: number;
    at: number;
}

export function createTabBucket(burst = BURST, perSecond = PER_SECOND) {
    const buckets = new Map<number, Bucket>();
    const dropped = new Map<number, number>();

    return {
        /** True if this tab may send one more batch now. */
        take(tabId: number, now = Date.now()): boolean {
            const b = buckets.get(tabId) ?? { tokens: burst, at: now };
            b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSecond);
            b.at = now;
            buckets.set(tabId, b);
            if (b.tokens >= 1) {
                b.tokens -= 1;
                return true;
            }
            dropped.set(tabId, (dropped.get(tabId) ?? 0) + 1);
            return false;
        },
        dropped: (tabId: number): number => dropped.get(tabId) ?? 0,
        forget(tabId: number): void {
            buckets.delete(tabId);
            dropped.delete(tabId);
        },
    };
}
