// Fails if the SHIPPED build asks for more than the extension is meant to.
//
//   npm run build -w app/extension && npm run check:manifest -w app/extension
//
// Site access is granted by the user, per site, at run time. A `matches` on a
// content script, or the e2e build's localhost grant leaking into a release,
// would turn that into access at install — and the build would still succeed.
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? new URL('../.output/chrome-mv3/manifest.json', import.meta.url);
const m = JSON.parse(readFileSync(path, 'utf8'));
const problems = [];

const PERMISSIONS = ['activeTab', 'alarms', 'scripting', 'storage'];
const OPTIONAL_HOSTS = ['http://*/*', 'https://*/*'];
const same = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...b].sort());

if (m.manifest_version !== 3) problems.push(`manifest_version is ${m.manifest_version}, expected 3`);
// Below this, storage.local cannot be closed to content scripts.
if (!(Number.parseInt(m.minimum_chrome_version, 10) >= 140)) problems.push(`minimum_chrome_version is ${m.minimum_chrome_version}, expected 140 or later`);
if (!same(m.permissions, PERMISSIONS)) problems.push(`permissions are ${JSON.stringify(m.permissions)}, expected ${JSON.stringify(PERMISSIONS)}`);
if (!same(m.optional_host_permissions, OPTIONAL_HOSTS)) problems.push(`optional_host_permissions are ${JSON.stringify(m.optional_host_permissions)}`);
for (const key of ['host_permissions', 'content_scripts', 'optional_permissions', 'externally_connectable']) {
    if (m[key] !== undefined) problems.push(`${key} must be absent, found ${JSON.stringify(m[key])}`);
}
// Only the panel may be framed by web pages, and only at a per-session address.
for (const r of m.web_accessible_resources ?? []) {
    if (!same(r.resources, ['panel.html'])) problems.push(`web accessible: ${JSON.stringify(r.resources)}, expected only panel.html`);
    if (r.use_dynamic_url !== true) problems.push('web accessible resources must set use_dynamic_url');
}

if (problems.length) {
    console.error(`Shipped manifest check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
}
console.log('Shipped manifest check passed.');
