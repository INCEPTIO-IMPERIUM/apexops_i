// What a content script (T1) can see. Results go on <html> data attributes for the runner.
const out = (k, v) => document.documentElement.setAttribute(`data-${k}`, typeof v === 'string' ? v : JSON.stringify(v));
const seen = [];
try {
    chrome.storage.onChanged.addListener((changes, area) => {
        seen.push({ area, keys: Object.keys(changes), values: Object.values(changes).map((c) => c.newValue) });
        out('changed', seen);
    });
    out('listener', 'attached');
} catch (err) {
    out('listener', `threw: ${err.message}`);
}
for (const name of ['local', 'session']) {
    try {
        chrome.storage[name].get('secret').then(
            (v) => out(`get-${name}`, v),
            (err) => out(`get-${name}`, `rejected: ${err.message}`)
        );
    } catch (err) {
        out(`get-${name}`, `threw: ${err.message}`);
    }
}
out('ready', 'yes');
