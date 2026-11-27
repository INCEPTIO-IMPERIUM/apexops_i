import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOLBAR_UNBOUND, TOOLBAR_UPDATE } from './toolbarChannel';
import { forgetToolbarTab, handleToolbarRequest, pushToolbarChanges } from './toolbarState';

/**
 * The worker's half of the toolbar (hardening H2). The toolbar runs in the
 * site's renderer, so what is asserted is what reaches it: this origin's
 * position and bound flag, and nothing when any other key changes.
 */

const A = 'https://a.example.test';
const B = 'https://b.example.test';
const binding = (name: string) => ({ apiUrl: 'http://localhost:3013', slug: name, projectId: 1, name, ingestKey: `pk_${name}` });

let local: Map<string, unknown>;
let session: Map<string, unknown>;
let sent: { tabId: number; message: Record<string, unknown> }[];
let deadTabs: Set<number>;

const area = (m: () => Map<string, unknown>) => ({
    get: async (k: string) => (m().has(k) ? { [k]: structuredClone(m().get(k)) } : {}),
    set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) m().set(k, structuredClone(v));
    },
});

beforeEach(() => {
    local = new Map<string, unknown>([['bindings', { [A]: binding('a'), [B]: binding('b') }]]);
    session = new Map();
    sent = [];
    deadTabs = new Set();
    vi.stubGlobal('browser', {
        storage: { local: area(() => local), session: area(() => session) },
        tabs: {
            sendMessage: async (tabId: number, message: Record<string, unknown>) => {
                if (deadTabs.has(tabId)) throw new Error('Receiving end does not exist');
                sent.push({ tabId, message });
            },
        },
    });
});

describe('toolbar-state', () => {
    it('answers for the given origin only: bound, and the default position', async () => {
        expect(await handleToolbarRequest({ type: 'toolbar-state' }, A, 1)).toEqual({ bound: true, pref: { right: 16, bottom: 16 } });
    });

    it('returns no binding fields at all — no key, no project', async () => {
        const reply = JSON.stringify(await handleToolbarRequest({ type: 'toolbar-state' }, A, 1));
        expect(reply).not.toMatch(/pk_|ingestKey|apiUrl|slug/);
    });

    it('an unbound site is told so, and its tab is not remembered', async () => {
        expect(await handleToolbarRequest({ type: 'toolbar-state' }, 'https://other.test', 9)).toMatchObject({ bound: false });
        expect(session.get('toolbarTabs') ?? {}).toEqual({});
    });
});

describe('toolbar-pref', () => {
    it('writes for the sender origin, never another', async () => {
        await handleToolbarRequest({ type: 'toolbar-pref', right: 40, bottom: 50, hidden: true }, A, 1);
        expect(local.get('toolbarPrefs')).toEqual({ [A]: { right: 40, bottom: 50, hidden: true } });
    });

    it.each([[-1], [Number.NaN], [Infinity], ['10'], [1e9]])('ignores a position that is not a sane px value (%s)', async (bad) => {
        await handleToolbarRequest({ type: 'toolbar-pref', right: bad as number }, A, 1);
        expect(local.get('toolbarPrefs')).toBeUndefined();
    });

    it('an unbound site cannot write', async () => {
        expect(await handleToolbarRequest({ type: 'toolbar-pref', hidden: true }, 'https://other.test', 9)).toEqual({ ok: false });
        expect(local.get('toolbarPrefs')).toBeUndefined();
    });
});

describe('pushes', () => {
    beforeEach(async () => {
        await handleToolbarRequest({ type: 'toolbar-state' }, A, 1);
        await handleToolbarRequest({ type: 'toolbar-state' }, A, 2);
        await handleToolbarRequest({ type: 'toolbar-state' }, B, 3);
    });

    it('a token rotation, a key refresh or a problem record sends nothing to any tab', async () => {
        await pushToolbarChanges({ accessToken: { oldValue: 'a', newValue: 'b' }, refreshToken: { oldValue: 'r1', newValue: 'r2' } });
        await pushToolbarChanges({ ingestProblems: { newValue: { [A]: { status: 401 } } } });
        const before = { [A]: binding('a'), [B]: binding('b') };
        await pushToolbarChanges({ bindings: { oldValue: before, newValue: { ...before, [A]: { ...binding('a'), ingestKey: 'pk_rotated' } } } });
        expect(sent).toEqual([]);
    });

    it("a changed position goes to that origin's tabs only, without anything else", async () => {
        local.set('toolbarPrefs', { [A]: { right: 40, bottom: 16 } });
        await pushToolbarChanges({ toolbarPrefs: { oldValue: {}, newValue: { [A]: { right: 40, bottom: 16 } } } });
        expect(sent.map((s) => s.tabId).sort()).toEqual([1, 2]);
        expect(sent[0]!.message).toEqual({ type: TOOLBAR_UPDATE, origin: A, pref: { right: 40, bottom: 16 } });
    });

    it('an unchanged origin in the same write is not told', async () => {
        const prefs = { [A]: { right: 40, bottom: 16 }, [B]: { right: 16, bottom: 16 } };
        await pushToolbarChanges({ toolbarPrefs: { oldValue: { ...prefs, [A]: { right: 16, bottom: 16 } }, newValue: prefs } });
        expect(sent.every((s) => s.message.origin === A)).toBe(true);
    });

    it('disconnecting a site tells its tabs to leave, and forgets them', async () => {
        const before = { [A]: binding('a'), [B]: binding('b') };
        await pushToolbarChanges({ bindings: { oldValue: before, newValue: { [B]: binding('b') } } });
        expect(sent).toEqual([
            { tabId: 1, message: { type: TOOLBAR_UNBOUND, origin: A } },
            { tabId: 2, message: { type: TOOLBAR_UNBOUND, origin: A } },
        ]);
        expect(session.get('toolbarTabs')).toEqual({ 3: B });
    });

    it('a tab that no longer listens is forgotten', async () => {
        deadTabs.add(2);
        await pushToolbarChanges({ toolbarPrefs: { oldValue: {}, newValue: { [A]: { right: 1, bottom: 1 } } } });
        expect(session.get('toolbarTabs')).toEqual({ 1: A, 3: B });
    });

    it('a closed tab is forgotten', async () => {
        await forgetToolbarTab(3);
        expect(session.get('toolbarTabs')).toEqual({ 1: A, 2: A });
    });
});
