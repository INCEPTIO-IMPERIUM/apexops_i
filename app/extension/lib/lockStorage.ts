/**
 * Close `storage.local` to content scripts (hardening H2). It holds the session
 * tokens and every bound site's ingest key, and by default any content script
 * — code in a site's renderer — can read it and hear every change to it.
 * `storage.session` is closed by default; set anyway so the rule is written here.
 *
 * `setAccessLevel` on `local` arrived later than on `session`: Chrome for
 * Testing 131 has no such method there, and calling it threw at the top of the
 * worker, which left the whole extension dead. The manifest therefore requires
 * `minimum_chrome_version` (wxt.config.ts), so a browser that cannot lock the
 * store cannot install the extension. The check below is the second line: it
 * reports, and never takes the worker down.
 *
 * Measured on Edge 158: after this, `storage.local.get` from a content script
 * rejects and `onChanged` delivers nothing there; without it, both leak
 * (spikes/h2-access-level).
 */

interface Lockable {
    setAccessLevel?: (options: { accessLevel: 'TRUSTED_CONTEXTS' }) => Promise<void>;
}

export function lockStorage(areas: Record<string, Lockable>, report: (message: string, err?: unknown) => void = console.error): void {
    for (const [name, area] of Object.entries(areas)) {
        if (typeof area.setAccessLevel !== 'function') {
            report(`[apexops] this browser cannot restrict storage.${name} to the extension; update the browser`);
            continue;
        }
        try {
            void area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch((err: unknown) => report(`[apexops] could not restrict storage.${name}`, err));
        } catch (err) {
            report(`[apexops] could not restrict storage.${name}`, err);
        }
    }
}
