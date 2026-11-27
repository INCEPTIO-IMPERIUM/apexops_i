import { MAX_BODY_CHARS, MAX_EVENTS_PER_BATCH, type IngestEvent } from './sanitize';

/**
 * Events waiting to reach /api/ingest, persisted so a stopped service worker
 * does not lose them (spec P3 step 6).
 *
 * MV3 stops the worker whenever it has been idle for ~30s, and at any point
 * the browser sees fit. Anything held only in memory is gone when that happens,
 * so every batch is written to storage *before* the send is attempted and
 * removed only after the server has taken it.
 *
 * Delivery is therefore at-least-once, not exactly-once: a worker stopped in
 * the gap between the server's 202 and the removal below sends that batch
 * again when it wakes. That window is one storage write wide; the common cases
 * — offline, server down, worker stopped with events still queued — lose
 * nothing and send nothing twice.
 */

export interface QueueItem {
    id: string;
    /** Origin of the site the events came from; selects the binding at send time. */
    origin: string;
    events: IngestEvent[];
    attempts: number;
}

export interface QueueStore {
    load(): Promise<QueueItem[]>;
    save(items: QueueItem[]): Promise<void>;
}

/**
 * `sent`: the server took it. `drop`: it never will (bad request, no binding) —
 * retrying only repeats the failure. `retry`: try again later (offline, 429, 5xx).
 */
export type SendResult = 'sent' | 'retry' | 'drop';

/** Bound on what a flood on one page — or a long outage — can pile up in storage. */
export const MAX_QUEUED_EVENTS = 1000;

const eventsOf = (items: QueueItem[], origin?: string) =>
    items.reduce((n, i) => (origin === undefined || i.origin === origin ? n + i.events.length : n), 0);

/**
 * Which batch to drop when the queue is full (hardening H3, D3).
 *
 * Oldest first — during a flood the newest batches describe the live failure —
 * but one noisy site may not push out another site's events: while some origin
 * holds more than half the queue and another origin has events waiting, the
 * noisy origin loses its own oldest batch.
 */
function evictionIndex(items: QueueItem[]): number {
    const byOrigin = new Map<string, number>();
    for (const i of items) byOrigin.set(i.origin, (byOrigin.get(i.origin) ?? 0) + i.events.length);
    if (byOrigin.size > 1) {
        for (const [origin, n] of byOrigin) {
            if (n > MAX_QUEUED_EVENTS / 2) return items.findIndex((i) => i.origin === origin);
        }
    }
    return 0;
}

/**
 * The head batch plus every later batch from the same site that fits in one
 * request: one POST for many page batches instead of one each. Within the
 * server's per-request event cap and the size one page batch may have.
 */
function nextGroup(items: QueueItem[]): QueueItem[] {
    const head = items[0];
    if (!head) return [];
    const group = [head];
    let events = head.events.length;
    let chars = JSON.stringify(head.events).length;
    for (const item of items.slice(1)) {
        if (item.origin !== head.origin) continue;
        const size = JSON.stringify(item.events).length;
        if (events + item.events.length > MAX_EVENTS_PER_BATCH || chars + size > MAX_BODY_CHARS) break;
        group.push(item);
        events += item.events.length;
        chars += size;
    }
    return group;
}

export function createIngestQueue(
    store: QueueStore,
    send: (item: QueueItem) => Promise<SendResult>,
    newId: () => string = () => crypto.randomUUID()
) {
    // Storage reads and writes interleave across awaits, so every
    // read-modify-write goes through this one chain. Two batches arriving
    // together must not each read the old list and overwrite the other.
    let chain: Promise<unknown> = Promise.resolve();
    const locked = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = chain.then(fn, fn);
        chain = run.catch(() => undefined);
        return run;
    };

    async function enqueue(origin: string, events: IngestEvent[]): Promise<void> {
        if (!events.length) return;
        await locked(async () => {
            const items = await store.load();
            items.push({ id: newId(), origin, events, attempts: 0 });
            let total = eventsOf(items);
            while (total > MAX_QUEUED_EVENTS && items.length > 1) total -= items.splice(evictionIndex(items), 1)[0]!.events.length;
            await store.save(items);
        });
    }

    let flushing: Promise<void> | null = null;

    /** Send queued batches in order until one must wait. Concurrent calls share one run. */
    function flush(): Promise<void> {
        if (flushing) return flushing;
        flushing = (async () => {
            try {
                for (;;) {
                    const group = await locked(async () => nextGroup(await store.load()));
                    const head = group[0];
                    if (!head) return;
                    const ids = new Set(group.map((g) => g.id));

                    let result: SendResult;
                    try {
                        result = await send({ ...head, events: group.flatMap((g) => g.events) });
                    } catch {
                        result = 'retry';
                    }

                    // One write for the whole group, whatever happened to it.
                    await locked(async () => {
                        const items = await store.load();
                        const next =
                            result === 'retry'
                                ? items.map((x) => (ids.has(x.id) ? { ...x, attempts: x.attempts + 1 } : x))
                                : items.filter((x) => !ids.has(x.id));
                        await store.save(next);
                    });
                    // The server is down or throttling: everything behind this
                    // batch would fail the same way. The retry alarm resumes.
                    if (result === 'retry') return;
                }
            } finally {
                flushing = null;
            }
        })();
        return flushing;
    }

    return { enqueue, flush };
}
