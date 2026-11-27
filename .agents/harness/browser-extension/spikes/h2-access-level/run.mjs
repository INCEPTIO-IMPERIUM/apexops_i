// H2 spike: can storage.local be closed to content scripts?
//   node .agents/harness/browser-extension/spikes/h2-access-level/run.mjs          # Edge
// Control: session is restricted by default, so the content script must be refused there.
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../../../', import.meta.url);
const require = createRequire(new URL('app/server/package.json', root));
const puppeteer = require('puppeteer');
const EXT = fileURLToPath(new URL(process.env.SPIKE_EXT ?? './ext', import.meta.url));

const server = http.createServer((_q, r) => r.end('<!doctype html><title>spike</title><p>page'));
await new Promise((r) => server.listen(8811, '127.0.0.1', r));

const browser = await puppeteer.launch({
    headless: false,
    executablePath: process.env.SPIKE_CHROME ? undefined : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-position=-2400,0'],
});
try {
    const t = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 15_000 });
    const worker = await t.worker();
    console.log('browser', await browser.version());
    console.log('worker setAccessLevel', await worker.evaluate(() => self.spike));

    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:8811/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.dataset.ready && document.documentElement.dataset.getLocal && document.documentElement.dataset.getSession, { timeout: 10_000 });
    // A "token rotation": does the content script's onChanged listener receive the new value?
    await worker.evaluate(async () => {
        await chrome.storage.local.set({ secret: 'local-rotated' });
        await chrome.storage.session.set({ secret: 'session-rotated' });
    });
    await new Promise((r) => setTimeout(r, 1000));
    const d = await page.evaluate(() => ({ ...document.documentElement.dataset }));
    console.log('content script sees', d);
} finally {
    await browser.close();
    server.close();
}
