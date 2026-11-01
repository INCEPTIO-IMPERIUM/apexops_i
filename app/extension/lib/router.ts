/**
 * Who may send the service worker which message — decided in one pure function,
 * default-deny (spec R18).
 *
 * Each sender gets an explicit allowlist of message types. A new extension page,
 * or a new message type, is refused until it is added here and in the tests.
 */

export const POPUP_PATH = '/popup.html';
export const PANEL_PATH = '/panel.html';

export const POPUP_TYPES: ReadonlySet<string> = new Set(['status', 'discover', 'connect', 'disconnect', 'logout']);
export const PANEL_TYPES: ReadonlySet<string> = new Set(['panel-state', 'panel-issues', 'panel-projects', 'panel-switch', 'panel-report', 'panel-signin']);

export interface SenderLike {
    id?: string;
    url?: string;
    origin?: string;
    tab?: { id?: number };
}

export type Route =
    | { kind: 'ingest'; origin: string; tabId: number }
    | { kind: 'popup' }
    | { kind: 'panel'; tabId: number };

/**
 * The path of the extension page that sent this, or null if it is not one of
 * ours.
 *
 * Decided by the sender's URL, not by `sender.tab`: an extension page opened in
 * a tab has one, and a content script running in a web page has one too. A
 * content script's `sender.url` is the web page's, which is what tells them
 * apart — a web page's URL is http(s), never our scheme.
 *
 * The scheme rather than our exact origin because the toolbar panel is loaded
 * through `use_dynamic_url`, whose host is a per-session random id, not the
 * extension id. `sender.id` is what says the page is this extension's.
 */
export function extensionPagePath(sender: SenderLike, runtimeId: string, extensionProtocol: string): string | null {
    if (sender.id !== runtimeId || typeof sender.url !== 'string') return null;
    try {
        const url = new URL(sender.url);
        return url.protocol === extensionProtocol ? url.pathname : null;
    } catch {
        return null;
    }
}

const ORIGIN = /^https?:\/\/[^/]+$/;

/** `null` means: ignore the message, answer nothing. */
export function route(message: unknown, sender: SenderLike, runtimeId: string, extensionProtocol: string): Route | null {
    if (sender.id !== runtimeId) return null;
    const type = (message as { type?: unknown } | null)?.type;
    if (typeof type !== 'string') return null;

    const path = extensionPagePath(sender, runtimeId, extensionProtocol);

    if (type === 'ingest') {
        // Our own content scripts, in a tab — never an extension page.
        if (path !== null || typeof sender.tab?.id !== 'number') return null;
        // The origin is the browser's record of the sender, never the message's:
        // a page must not be able to pick which project it writes into.
        let origin: string | null = sender.origin ?? null;
        if (!origin && sender.url) {
            try {
                origin = new URL(sender.url).origin;
            } catch {
                origin = null;
            }
        }
        if (!origin || !ORIGIN.test(origin)) return null;
        return { kind: 'ingest', origin, tabId: sender.tab.id };
    }

    if (path === POPUP_PATH) return POPUP_TYPES.has(type) ? { kind: 'popup' } : null;

    if (path === PANEL_PATH) {
        // Always inside a tab; which one — and so which site — is the
        // browser's answer, not the message's.
        if (!PANEL_TYPES.has(type) || typeof sender.tab?.id !== 'number') return null;
        return { kind: 'panel', tabId: sender.tab.id };
    }

    return null;
}
