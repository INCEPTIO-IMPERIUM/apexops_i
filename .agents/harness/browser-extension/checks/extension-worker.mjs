// The extension's service worker, once it can be used.
//
// A worker target appears before its script context has the extension APIs:
// evaluating at once can raise "chrome is not defined" (seen on Chrome 158 in
// CI). And a browser may run other workers called background.js. So: poll until
// one of them answers as ApexOps.
export async function extensionWorker(browser, timeout = 15_000) {
    const end = Date.now() + timeout;
    let last = 'no service worker with /background.js';
    for (;;) {
        for (const target of browser.targets()) {
            if (target.type() !== 'service_worker' || !target.url().endsWith('/background.js')) continue;
            try {
                const worker = await target.worker();
                const name = await worker.evaluate(() => globalThis.chrome?.runtime?.getManifest?.().name ?? null);
                if (name === 'ApexOps') return { target, worker };
                last = `${target.url()} answered ${JSON.stringify(name)}`;
            } catch (err) {
                last = `${target.url()}: ${err.message}`;
            }
        }
        if (Date.now() > end) throw new Error(`the extension worker did not become ready: ${last}`);
        await new Promise((r) => setTimeout(r, 200));
    }
}
