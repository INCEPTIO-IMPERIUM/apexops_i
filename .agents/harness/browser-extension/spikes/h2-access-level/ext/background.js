// What the worker can do: try to restrict each area, then store a secret in each.
const result = {};
self.spike = (async () => {
    for (const name of ['local', 'session', 'sync']) {
        try {
            await chrome.storage[name].setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
            result[name] = 'ok';
        } catch (err) {
            result[name] = `threw: ${err && err.message}`;
        }
    }
    await chrome.storage.local.set({ secret: 'local-secret' });
    await chrome.storage.session.set({ secret: 'session-secret' });
    return result;
})();

// Later writes, so the content script's onChanged listener has something to see.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg === 'rotate') {
        Promise.all([chrome.storage.local.set({ secret: 'local-rotated' }), chrome.storage.session.set({ secret: 'session-rotated' })]).then(() => reply('done'));
        return true;
    }
});
