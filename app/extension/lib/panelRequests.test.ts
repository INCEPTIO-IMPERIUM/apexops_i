import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Binding } from './bindings';

const h = vi.hoisted(() => ({
    fetchWithAuth: vi.fn(),
    connectSite: vi.fn(),
}));

vi.mock('@apexops/shared/api', () => ({ configureApi: vi.fn(), fetchWithAuth: h.fetchWithAuth }));
vi.mock('@apexops/shared/auth', () => ({ getAccessToken: () => 'token' }));
vi.mock('./session', async (orig) => ({
    ...(await orig<typeof import('./session')>()),
    ensureSession: async () => undefined,
    storedApiUrl: async () => 'http://localhost:3013',
    whoami: async () => ({ signedIn: true }),
    login: vi.fn(),
}));
vi.mock('./connect', async (orig) => ({ ...(await orig<typeof import('./connect')>()), connectSite: h.connectSite }));

import { handlePanelRequest, type PanelContext } from './panelRequests';

const SITE = 'https://shop.example.test';
const BINDING: Binding = { apiUrl: 'http://localhost:3013', slug: 'demo', projectId: 7, name: 'Demo', ingestKey: 'pk_x', appOrigin: 'http://localhost:5199' };
const ctx = (over: Partial<PanelContext> = {}): PanelContext => ({ version: '0.1.0', tabId: 1, tabUrl: `${SITE}/cart?token=secret#frag`, tabTitle: 'Cart', ...over });

const res = (status: number, body?: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
    h.fetchWithAuth.mockReset();
    h.connectSite.mockReset();
    vi.stubGlobal('browser', {
        storage: {
            local: { get: async (k: string) => (k === 'bindings' ? { bindings: { [SITE]: BINDING } } : {}) },
            session: { get: async () => ({}) },
        },
    });
});

describe('a site that is not bound', () => {
    it('panel-state says so, and the rest refuse', async () => {
        const other = ctx({ tabUrl: 'https://other.example.test/' });
        expect(await handlePanelRequest({ type: 'panel-state' }, other)).toEqual({ ok: true, data: { bound: false } });
        expect(await handlePanelRequest({ type: 'panel-issues' }, other)).toMatchObject({ ok: false, error: { code: 'not-bound' } });
        expect(await handlePanelRequest({ type: 'panel-report', title: 't', description: '', priority: 'low' }, other)).toMatchObject({ ok: false, error: { code: 'not-bound' } });
        expect(h.fetchWithAuth).not.toHaveBeenCalled();
    });

    it.each([[null], ['chrome://extensions'], ['about:blank'], ['not a url']])('a tab url that is not a site (%s) is not bound', async (tabUrl) => {
        expect(await handlePanelRequest({ type: 'panel-state' }, ctx({ tabUrl }))).toEqual({ ok: true, data: { bound: false } });
    });
});

describe('panel-switch', () => {
    it.each([['../admin'], ['A'], [''], ['a b'], ['x'.repeat(101)], ['demo?x=1']])('rejects the slug %j before any request', async (slug) => {
        expect(await handlePanelRequest({ type: 'panel-switch', slug }, ctx())).toMatchObject({ ok: false, error: { code: 'bad-project' } });
        expect(h.connectSite).not.toHaveBeenCalled();
    });

    it('rejects a slug that is not a string', async () => {
        expect(await handlePanelRequest({ type: 'panel-switch', slug: 5 as unknown as string }, ctx())).toMatchObject({ ok: false, error: { code: 'bad-project' } });
    });

    it("switches on the binding's own API and the sender's own site", async () => {
        h.connectSite.mockResolvedValue({ name: 'Next', slug: 'next' });
        const reply = await handlePanelRequest({ type: 'panel-switch', slug: 'next' }, ctx());
        expect(reply).toEqual({ ok: true, data: { name: 'Next', slug: 'next' } });
        expect(h.connectSite).toHaveBeenCalledWith(expect.objectContaining({ slug: 'next', apiUrl: BINDING.apiUrl }), SITE);
    });
});

describe('panel-report', () => {
    const report = { type: 'panel-report', title: '  Broken cart ', description: 'It fails', priority: 'high' } as const;

    it("files the ticket in the binding's project, with a Page line stripped of query and fragment", async () => {
        h.fetchWithAuth.mockResolvedValue(res(201, { id: 'TICK-042' }));
        const reply = await handlePanelRequest(report, ctx());

        expect(reply).toEqual({ ok: true, data: { id: 'TICK-042', url: 'http://localhost:5199/p/demo/board' } });
        const [path, init] = h.fetchWithAuth.mock.calls[0]!;
        expect(path).toBe('/api/tickets');
        expect(init.body).toMatchObject({ projectId: 7, title: 'Broken cart', priority: 'high' });
        const description = init.body.description as string;
        expect(description).toContain(`Page: ${SITE}/cart`);
        expect(description).toContain('Tab title: Cart');
        expect(description).toContain('Reported from the ApexOps extension 0.1.0');
        expect(description).not.toMatch(/secret|frag|\?/);
    });

    it('turns an unknown priority into medium', async () => {
        h.fetchWithAuth.mockResolvedValue(res(201, { id: 'TICK-1' }));
        await handlePanelRequest({ ...report, priority: 'urgent!!' }, ctx());
        expect(h.fetchWithAuth.mock.calls[0]![1].body.priority).toBe('medium');
    });

    it('refuses a blank title without a request', async () => {
        expect(await handlePanelRequest({ ...report, title: '   ' }, ctx())).toMatchObject({ ok: false, error: { code: 'bad-report' } });
        expect(h.fetchWithAuth).not.toHaveBeenCalled();
    });

    it('maps the server\'s 400 "Project not found" (not a member) to no-access', async () => {
        h.fetchWithAuth.mockResolvedValue(res(400, { error: 'Project not found' }));
        expect(await handlePanelRequest(report, ctx())).toMatchObject({ ok: false, error: { code: 'no-access' } });
    });

    it('an expired session is signed-out, and a 500 is a server problem', async () => {
        h.fetchWithAuth.mockResolvedValueOnce(res(401));
        expect(await handlePanelRequest(report, ctx())).toMatchObject({ ok: false, error: { code: 'signed-out' } });
        h.fetchWithAuth.mockResolvedValueOnce(res(500));
        expect(await handlePanelRequest(report, ctx())).toMatchObject({ ok: false, error: { code: 'server' } });
    });
});

describe('unknown panel requests', () => {
    it('are not understood', async () => {
        expect(await handlePanelRequest({ type: 'disconnect' } as never, ctx())).toMatchObject({ ok: false, error: { code: 'unknown-request' } });
    });
});
