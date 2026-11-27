import { readBindings, type Bindings } from './bindings';
import { TOOLBAR_UNBOUND, TOOLBAR_UPDATE } from './toolbarChannel';
import { readToolbarPref, TOOLBAR_PREFS_KEY, updateToolbarPref, type ToolbarPref, type ToolbarPrefs } from './toolbarPrefs';

/**
 * The worker's half of the toolbar (hardening H2).
 *
 * The toolbar content script runs in the site's renderer (T1) and reads no
 * storage: `storage.local` is closed to content scripts at worker start. It asks
 * the worker for the one thing it needs — is this site bound, and where does
 * the rail sit — and the worker answers for the sender's own origin only, as
 * the browser reports it. Changes are pushed to the tabs that asked, so a token
 * rotation or another site's binding never reaches a renderer.
 */

export type ToolbarRequest = { type: 'toolbar-state' } | { type: 'toolbar-pref'; right?: number; bottom?: number; hidden?: boolean };

export interface ToolbarStateReply {
    bound: boolean;
    pref: ToolbarPref;
}

/** Tabs with a toolbar, and the origin it is on. `storage.session`: a tab id means nothing after a restart. */
const TABS_KEY = 'toolbarTabs';
type Tabs = Record<string, string>;

async function readTabs(): Promise<Tabs> {
    const value = (await browser.storage.session.get(TABS_KEY))[TABS_KEY];
    return value && typeof value === 'object' ? (value as Tabs) : {};
}

let chain: Promise<unknown> = Promise.resolve();
function updateTabs(change: (t: Tabs) => Tabs): Promise<void> {
    const run = chain.then(async () => {
        await browser.storage.session.set({ [TABS_KEY]: change(await readTabs()) });
    });
    chain = run.catch(() => undefined);
    return run;
}

export const forgetToolbarTab = (tabId: number): Promise<void> =>
    updateTabs((t) => {
        const { [tabId]: _gone, ...rest } = t;
        return rest;
    });

/** A position the rail can use: a finite number of px, within reason. */
const px = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100_000;

export async function handleToolbarRequest(req: ToolbarRequest, origin: string, tabId: number): Promise<unknown> {
    const bound = !!(await readBindings())[origin];

    if (req.type === 'toolbar-state') {
        if (bound) await updateTabs((t) => ({ ...t, [tabId]: origin }));
        return { bound, pref: await readToolbarPref(origin) } satisfies ToolbarStateReply;
    }

    if (req.type === 'toolbar-pref') {
        // An unbound site has no toolbar, so nothing to remember for it.
        if (!bound) return { ok: false };
        const change: Partial<ToolbarPref> = {};
        if (px(req.right)) change.right = req.right;
        if (px(req.bottom)) change.bottom = req.bottom;
        if (typeof req.hidden === 'boolean') change.hidden = req.hidden;
        if (Object.keys(change).length) await updateToolbarPref(origin, change);
        return { ok: true };
    }

    return null;
}

const samePref = (a: ToolbarPref | undefined, b: ToolbarPref | undefined) =>
    a?.right === b?.right && a?.bottom === b?.bottom && !!a?.hidden === !!b?.hidden;

async function tell(tabs: Tabs, origin: string, message: object): Promise<void> {
    const ids = Object.keys(tabs).filter((id) => tabs[id] === origin);
    await Promise.all(
        ids.map((id) =>
            // A tab that has navigated away has no listener: forget it.
            browser.tabs.sendMessage(Number(id), { ...message, origin }).catch(() => forgetToolbarTab(Number(id)))
        )
    );
}

/**
 * Called from the worker's `storage.onChanged`. Sends only what a toolbar shows:
 * a changed position or hidden flag for its own origin, or "this site was
 * disconnected". Every other key — tokens, ingest keys, a rotated key on the
 * same binding — sends nothing.
 */
export async function pushToolbarChanges(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>): Promise<void> {
    const prefs = changes[TOOLBAR_PREFS_KEY];
    const bindings = changes.bindings;
    if (!prefs && !bindings) return;
    const tabs = await readTabs();

    if (prefs) {
        const before = (prefs.oldValue ?? {}) as ToolbarPrefs;
        const after = (prefs.newValue ?? {}) as ToolbarPrefs;
        for (const origin of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (!samePref(before[origin], after[origin])) await tell(tabs, origin, { type: TOOLBAR_UPDATE, pref: await readToolbarPref(origin) });
        }
    }

    if (bindings) {
        const before = (bindings.oldValue ?? {}) as Bindings;
        const after = (bindings.newValue ?? {}) as Bindings;
        for (const origin of Object.keys(before)) {
            if (after[origin]) continue;
            await tell(tabs, origin, { type: TOOLBAR_UNBOUND });
            await updateTabs((t) => Object.fromEntries(Object.entries(t).filter(([, o]) => o !== origin)));
        }
    }
}
