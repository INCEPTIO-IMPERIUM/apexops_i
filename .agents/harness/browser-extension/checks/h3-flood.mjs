// H3 measurement: what a page firing 1,000 capture events in 1 s costs the worker.
//   npm run build:e2e -w app/extension && P5_BROWSER=edge node .agents/harness/browser-extension/checks/h3-flood.mjs
// No rig needed: the binding points at a local stub that counts what reaches "the API".
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../../', import.meta.url);
const require = createRequire(new URL('app/server/package.json', root));
const puppeteer = require('puppeteer');
const EXT = fileURLToPath(new URL('app/extension/.output/chrome-mv3-e2e', root));
const EDGE = process.env.P5_BROWSER === 'edge';
const SITE = 'http://127.0.0.1:8797';
const STUB = 'http://127.0.0.1:8799';
const N = Number(process.env.H3_EVENTS ?? 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stub = { requests: 0, events: 0 };
const servers = [
    http.createServer((q, r) => {
        let body = '';
        q.on('data', (c) => (body += c));
        q.on('end', () => {
            if (q.url === '/api/ingest' && q.method === 'POST') {
                stub.requests++;
                stub.events += JSON.parse(body).events.length;
            }
            r.writeHead(202, { 'Access-Control-Allow-Origin': '*' }).end('{}');
        });
    }).listen(8799, '127.0.0.1'),
    http.createServer((_q, r) => r.end('<!doctype html><title>flood</title><p>flood')).listen(8797, '127.0.0.1'),
];

const browser = await puppeteer.launch({
    headless: false,
    executablePath: EDGE ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' : undefined,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--window-position=-2400,0'],
});
try {
    const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15_000 });
    const sw = await target.worker();
    await sw.evaluate(
        (origin, apiUrl) => chrome.storage.local.set({ bindings: { [origin]: { apiUrl, slug: 'flood', projectId: 1, name: 'Flood', ingestKey: 'pk_flood' } } }),
        SITE,
        STUB
    );
    await sleep(1500); // registrations follow the binding
    const page = await browser.newPage();
    await page.goto(`${SITE}/`, { waitUntil: 'load' });
    await sleep(800);

    // Count every storage call the worker makes from here on.
    await sw.evaluate(() => {
        self.__h3 = { reads: 0, writes: 0, rawGet: chrome.storage.session.get.bind(chrome.storage.session) };
        for (const name of ['local', 'session']) {
            const area = chrome.storage[name];
            const get = area.get.bind(area);
            const set = area.set.bind(area);
            area.get = (...a) => (self.__h3.reads++, get(...a));
            area.set = (...a) => (self.__h3.writes++, set(...a));
        }
    });
    const cdp = await target.createCDPSession();
    const cpu = async () => {
        try {
            const { metrics } = await cdp.send('Performance.getMetrics');
            return metrics.find((m) => m.name === 'TaskDuration')?.value ?? null;
        } catch {
            return null;
        }
    };
    await cdp.send('Performance.enable').catch(() => undefined);
    const cpu0 = await cpu();

    // The page dispatches the capture event itself (any page can, spec S1): one event per batch.
    const t0 = Date.now();
    await page.evaluate(
        (n) =>
            new Promise((done) => {
                const body = JSON.stringify({ events: [{ level: 'error', message: 'flood', count: 1 }] });
                let sent = 0;
                const tick = setInterval(() => {
                    for (let i = 0; i < n / 100 && sent < n; i++, sent++) document.dispatchEvent(new CustomEvent('apexops:capture', { detail: body }));
                    if (sent >= n) clearInterval(tick), done();
                }, 10);
            }),
        N
    );
    const fireMs = Date.now() - t0;
    // Drained = the queue is empty (read without being counted) and nothing new reached the API for 1 s; 120 s cap.
    const queued = () => sw.evaluate(() => self.__h3.rawGet('ingestQueue').then((v) => v.ingestQueue?.length ?? 0));
    let drainMs = null;
    let seen = -1;
    let quietSince = Date.now();
    while (Date.now() - t0 < 120_000) {
        if (stub.events !== seen) (seen = stub.events), (quietSince = Date.now());
        if ((await queued()) === 0 && Date.now() - quietSince > 1000) {
            drainMs = quietSince - t0;
            break;
        }
        await sleep(250);
    }
    const counts = await sw.evaluate(() => ({ reads: self.__h3.reads, writes: self.__h3.writes }));
    const queue = await sw.evaluate(() => chrome.storage.session.get(['ingestQueue', 'tabCounts']).then((v) => ({ items: v.ingestQueue?.length ?? 0, events: (v.ingestQueue ?? []).reduce((n, i) => n + i.events.length, 0), maxAttempts: Math.max(0, ...(v.ingestQueue ?? []).map((i) => i.attempts)), tabCounts: v.tabCounts })));
    const problems = await sw.evaluate(() => chrome.storage.local.get('ingestProblems').then((v) => v.ingestProblems ?? null));
    const cpu1 = await cpu();
    const result = {
        browser: await browser.version(),
        fired: N,
        fireMs,
        msUntilQueueEmpty: drainMs ?? 'not within 120000',
        apiRequests: stub.requests,
        eventsDelivered: stub.events,
        storageReads: counts.reads,
        storageWrites: counts.writes,
        leftInQueue: queue,
        ingestProblems: problems,
        workerTaskSeconds: cpu0 === null || cpu1 === null ? 'not available' : +(cpu1 - cpu0).toFixed(3),
    };
    console.log(JSON.stringify(result, null, 2));
} finally {
    await browser.close();
    servers.forEach((s) => s.close());
}
