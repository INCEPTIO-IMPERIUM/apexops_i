import { describe, expect, it } from 'vitest';
import { PANEL_PATH, PANEL_TYPES, POPUP_PATH, POPUP_TYPES, route, type SenderLike } from './router';

/**
 * The trust boundary of the worker (spec R18). Every sender × message pairing
 * that matters is spelled out, because the property is "everything not listed
 * is refused".
 */

const ID = 'ext-id';
const SCHEME = 'chrome-extension:';
const go = (message: unknown, sender: SenderLike) => route(message, sender, ID, SCHEME);

const popup: SenderLike = { id: ID, url: `chrome-extension://${ID}${POPUP_PATH}` };
// The panel is served from a use_dynamic_url host, not the extension id.
const panel: SenderLike = { id: ID, url: `chrome-extension://random-dynamic-uuid${PANEL_PATH}`, tab: { id: 7 } };
const content: SenderLike = { id: ID, url: 'https://shop.example.test/cart?x=1', origin: 'https://shop.example.test', tab: { id: 3 } };

describe('ingest', () => {
    it('comes from our content script, with the origin taken from the sender', () => {
        expect(go({ type: 'ingest', body: 'x' }, content)).toEqual({ kind: 'ingest', origin: 'https://shop.example.test', tabId: 3 });
    });

    it('falls back to the sender url when there is no origin', () => {
        expect(go({ type: 'ingest' }, { ...content, origin: undefined })).toMatchObject({ origin: 'https://shop.example.test' });
    });

    it('ignores any origin the message claims', () => {
        expect(go({ type: 'ingest', origin: 'https://victim.test' }, content)).toMatchObject({ origin: 'https://shop.example.test' });
    });

    it.each([
        ['an extension page (the popup)', popup],
        ['an extension page in a tab (the panel)', panel],
        // Isolates the extension-page guard from the origin check that would also refuse these.
        ['an extension page that reports an http origin', { ...panel, origin: 'https://shop.example.test' }],
        ['another extension', { ...content, id: 'someone-else' }],
        ['a sender with no tab', { ...content, tab: undefined }],
        ['a sender whose tab has no id', { ...content, tab: {} }],
        ['a sender with no origin and no url', { id: ID, tab: { id: 3 } }],
        ['a sender whose origin is not http(s)', { ...content, origin: 'null' }],
    ])('is refused from %s', (_n, sender) => {
        expect(go({ type: 'ingest' }, sender)).toBeNull();
    });
});

describe('popup', () => {
    it.each([...POPUP_TYPES])('may send %s', (type) => {
        expect(go({ type }, popup)).toEqual({ kind: 'popup' });
    });

    it.each([...PANEL_TYPES])('may not send %s', (type) => {
        expect(go({ type }, popup)).toBeNull();
    });

    it('is not a popup if its path is anything else', () => {
        expect(go({ type: 'status' }, { id: ID, url: `chrome-extension://${ID}/options.html` })).toBeNull();
        expect(go({ type: 'status' }, { id: ID, url: `chrome-extension://${ID}/popup.html.evil` })).toBeNull();
    });
});

describe('panel', () => {
    it.each([...PANEL_TYPES])('may send %s, for the tab the browser says it is in', (type) => {
        expect(go({ type }, panel)).toEqual({ kind: 'panel', tabId: 7 });
    });

    it.each([...POPUP_TYPES])('may not send the popup request %s (disconnect and logout above all)', (type) => {
        expect(go({ type }, panel)).toBeNull();
    });

    it('needs a tab', () => {
        expect(go({ type: 'panel-state' }, { ...panel, tab: undefined })).toBeNull();
        expect(go({ type: 'panel-state' }, { ...panel, tab: {} })).toBeNull();
    });
});

describe('everything else is refused', () => {
    it.each([
        ['a foreign sender id', { ...popup, id: 'other' }],
        ['an http sender url claiming a popup path', { id: ID, url: `https://evil.test${POPUP_PATH}`, tab: { id: 1 } }],
        ['an http sender url claiming the panel path', { id: ID, url: `https://evil.test${PANEL_PATH}`, tab: { id: 1 } }],
        ['an unknown extension page', { id: ID, url: `chrome-extension://${ID}/new-page.html`, tab: { id: 1 } }],
        ['a sender with no url', { id: ID }],
        ['a sender with an unparseable url', { id: ID, url: 'not a url' }],
    ])('%s', (_n, sender) => {
        for (const type of [...POPUP_TYPES, ...PANEL_TYPES]) expect(go({ type }, sender)).toBeNull();
    });

    it.each([[null], [undefined], ['status'], [{}], [{ type: 1 }], [{ type: 'unknown' }], [{ type: '__proto__' }]])('a message that is not a known request: %j', (message) => {
        expect(go(message, popup)).toBeNull();
        expect(go(message, panel)).toBeNull();
        expect(go(message, content)).toBeNull();
    });
});
