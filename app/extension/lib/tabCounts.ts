/**
 * How many events each tab has handed to the extension (spec 8.5 P5 #2): the
 * panel's "N events sent from this tab", which answers "is it capturing?"
 * without opening the web app.
 *
 * Counted when the worker accepts a batch, which is also when it is queued for
 * delivery. `storage.session` because a tab id means nothing after a restart;
 * the worker forgets a tab when it closes, and when it starts loading a new page.
 *
 * Keyed by tab AND origin (hardening H3): a tab that moves from one bound site
 * to another must not show the first site's count on the second.
 */

const KEY = 'tabCounts';

type Counts = Record<string, number>;

async function read(): Promise<Counts> {
    const value = (await browser.storage.session.get(KEY))[KEY];
    return value && typeof value === 'object' ? (value as Counts) : {};
}

let chain: Promise<unknown> = Promise.resolve();

function update(change: (c: Counts) => Counts): Promise<void> {
    const run = chain.then(async () => {
        await browser.storage.session.set({ [KEY]: change(await read()) });
    });
    chain = run.catch(() => undefined);
    return run;
}

const keyOf = (tabId: number, origin: string) => `${tabId}|${origin}`;

export const countEvents = (tabId: number, origin: string, n: number): Promise<void> =>
    n > 0 ? update((c) => ({ ...c, [keyOf(tabId, origin)]: (c[keyOf(tabId, origin)] ?? 0) + n })) : Promise.resolve();

export const forgetTab = (tabId: number): Promise<void> =>
    update((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith(`${tabId}|`))));

export async function eventsFromTab(tabId: number, origin: string): Promise<number> {
    return (await read())[keyOf(tabId, origin)] ?? 0;
}
