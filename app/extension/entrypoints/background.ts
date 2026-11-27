import { setClientLabel } from '@apexops/shared/api';
import { readBindings, BINDINGS_KEY, type Binding } from '@/lib/bindings';
import { refreshBindingKey } from '@/lib/connect';
import { clearIngestProblem, recordIngestProblem } from '@/lib/ingestProblems';
import { createIngestQueue, type QueueItem, type SendResult } from '@/lib/ingestQueue';
import type { PanelRequest, Request } from '@/lib/messages';
import { handlePanelRequest } from '@/lib/panelRequests';
import { route } from '@/lib/router';
import { syncRegistrations } from '@/lib/registration';
import { handleRequest } from '@/lib/requests';
import { sanitizeBatch } from '@/lib/sanitize';
import { ensureSession } from '@/lib/session';
import { countEvents, forgetTab } from '@/lib/tabCounts';
import { TOOLBAR_COMMAND, TOOLBAR_TOGGLE } from '@/lib/toolbarChannel';
import { forgetToolbarTab, handleToolbarRequest, pushToolbarChanges, type ToolbarRequest } from '@/lib/toolbarState';

/**
 * The service worker: the only part of the extension that talks to ApexOps.
 *
 * It keeps the content-script registrations in step with the bindings, accepts
 * captured batches from the bridge, delivers them to /api/ingest with the bound
 * project's key (surviving its own shutdown), and answers the popup. Sessions,
 * refresh and every JWT call live here and nowhere else (spec X2).
 */

const QUEUE_KEY = 'ingestQueue';
const RETRY_ALARM = 'ingest-retry';

const extensionOrigin = () => new URL(browser.runtime.getURL('/')).origin;

const queue = createIngestQueue(
    {
        // storage.session: survives the worker being stopped, not the browser
        // being closed — right for events that are only worth sending soon.
        load: async () => ((await browser.storage.session.get(QUEUE_KEY))[QUEUE_KEY] as QueueItem[]) ?? [],
        save: (items) => browser.storage.session.set({ [QUEUE_KEY]: items }),
    },
    deliver
);

async function post(binding: Binding, item: QueueItem): Promise<Response> {
    return fetch(`${binding.apiUrl}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Apexops-Key': binding.ingestKey },
        body: JSON.stringify({ key: binding.ingestKey, events: item.events }),
        credentials: 'omit',
    });
}

async function deliver(item: QueueItem): Promise<SendResult> {
    const binding = (await readBindings())[item.origin];
    // Unbound since it was captured: the user no longer wants this site sent.
    if (!binding) return 'drop';

    let res = await post(binding, item);

    // 401 = the key is no longer valid. If the owner rotated it, the binding can
    // learn the new one from the API (spec X13) — once, then try again straight
    // away rather than waiting for the retry alarm.
    if (res.status === 401 && (await refreshBindingKey(item.origin)) === 'changed') {
        const fresh = (await readBindings())[item.origin];
        if (fresh) res = await post(fresh, item);
    }

    if (res.ok) {
        await clearIngestProblem(item.origin);
        return 'sent';
    }
    if (res.status === 429 || res.status >= 500) return 'retry';

    // 400/401/403/413: repeating it changes nothing. Say why, where a person will see it.
    const reason =
        res.status === 401
            ? 'The project rejected the ingest key, and it could not be refreshed. Sign in to the extension again, or reconnect this site.'
            : res.status === 403
              ? `The project only accepts events from listed origins, and this extension is not on the list. Add ${extensionOrigin()} to its allowed origins.`
              : `The server refused the events (${res.status}).`;
    await recordIngestProblem(item.origin, res.status, reason);
    return 'drop';
}

async function onIngest(body: unknown, origin: string, tabId: number): Promise<void> {
    if (!(await readBindings())[origin]) return;

    const events = sanitizeBatch(body);
    await queue.enqueue(origin, events);
    await countEvents(tabId, events.length);
    await queue.flush();
}

type Respond = (reply: unknown) => void;

async function answer(work: () => Promise<unknown>, sendResponse: Respond): Promise<void> {
    try {
        sendResponse(await work());
    } catch (err) {
        console.error('[apexops] request failed', err);
        sendResponse({ ok: false, error: { code: 'internal', message: 'Something went wrong inside the extension.' } });
    }
}

/** Alt+Shift+A: tell the toolbar on the active tab to open or close its panel. */
async function onCommand(command: string): Promise<void> {
    if (command !== TOOLBAR_COMMAND) return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id !== 'number') return;
    // No toolbar on this tab (an unbound site) means no listener: nothing to do.
    await browser.tabs.sendMessage(tab.id, { type: TOOLBAR_TOGGLE }).catch(() => undefined);
}

/**
 * Close `storage.local` to content scripts (hardening H2). It holds the session
 * tokens and every bound site's ingest key, and by default any content script
 * — code in a site's renderer — can read it and hear every change to it.
 * `storage.session` is closed by default; set anyway so the rule is written here.
 *
 * Measured on Edge 158: after this, `storage.local.get` from a content script
 * rejects and `onChanged` delivers nothing there; without it, both leak
 * (spikes/h2-access-level). Not measured on Chrome.
 */
function lockStorage(): void {
    for (const area of [browser.storage.local, browser.storage.session]) {
        void area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch((err: unknown) => console.error('[apexops] could not restrict storage', err));
    }
}

export default defineBackground(() => {
    // First, before any listener can run code that writes a secret.
    lockStorage();
    browser.runtime.onInstalled.addListener(lockStorage);

    // Before anything can log in or refresh: every session this worker mints or
    // rotates is labelled as the extension's (spec F12).
    setClientLabel(`extension/${browser.runtime.getManifest().version}`);

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // Who may send what is `route`'s call, and it denies by default: the
        // panel lives on a site someone else controls, so it cannot ask for what
        // the popup can (spec R18).
        const where = route(message, sender, browser.runtime.id, new URL(extensionOrigin()).protocol);
        if (!where) return undefined;
        const version = browser.runtime.getManifest().version;

        if (where.kind === 'ingest') {
            void onIngest((message as { body?: unknown }).body, where.origin, where.tabId);
            return undefined; // the page side never waits on the worker
        }

        if (where.kind === 'toolbar') {
            void answer(() => handleToolbarRequest(message as ToolbarRequest, where.origin, where.tabId), sendResponse);
            return true;
        }

        if (where.kind === 'panel') {
            const tab = sender.tab!;
            void answer(
                () => handlePanelRequest(message as PanelRequest, { version, tabId: where.tabId, tabUrl: tab.url ?? null, tabTitle: tab.title ?? '' }),
                sendResponse
            );
            return true;
        }

        void answer(() => handleRequest(message as Request, { version, extensionOrigin: extensionOrigin() }), sendResponse);
        return true; // keep the channel open for the async reply
    });

    browser.commands.onCommand.addListener((command) => void onCommand(command));
    browser.tabs.onRemoved.addListener((tabId) => {
        void forgetTab(tabId);
        void forgetToolbarTab(tabId);
    });

    browser.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[BINDINGS_KEY]) void syncRegistrations();
        void pushToolbarChanges(changes);
    });

    // A site's access can be revoked from the browser's own extension settings,
    // or granted again. Registrations must follow, or a revoked site keeps its
    // scripts registered until the next worker start.
    browser.permissions.onRemoved.addListener(() => void syncRegistrations());
    browser.permissions.onAdded.addListener(() => void syncRegistrations());

    // Chrome's floor for alarms is 30s. It is the safety net for batches that
    // could not be sent, including across a worker restart.
    void browser.alarms.create(RETRY_ALARM, { periodInMinutes: 0.5 });
    browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === RETRY_ALARM) void queue.flush();
    });

    // Every worker start: registrations persist across sessions, but a start is
    // also the moment to repair them, load the session, and drain the queue.
    void ensureSession();
    void syncRegistrations();
    void queue.flush();
});
