// The one project the browser checks expect, on a fresh database.
//
//   npm run seed:dev --workspace app/server     # the two dev accounts, first
//   node .agents/harness/browser-extension/checks/ci-seed.mjs
//
// Created through the API, as a person would, owned by dev.user. Safe to re-run.
const API = process.env.SEED_API ?? 'http://localhost:3013';
const SLUG = 'sprint2-demo';

const json = async (path, init = {}) => {
    const res = await fetch(`${API}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
    return { status: res.status, body: await res.json().catch(() => null) };
};

// The password is the published one in app/server/src/scripts/seed-dev-users.ts.
const login = await json('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'dev.user@apexops.local', password: 'DevPass123' }) });
if (!login.body?.accessToken) throw new Error(`login failed (${login.status})`);
const auth = { Authorization: `Bearer ${login.body.accessToken}` };

const existing = await json(`/api/projects/${SLUG}`, { headers: auth });
if (existing.status === 200) {
    console.log(`${SLUG} already exists`);
} else {
    const made = await json('/api/projects', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Sprint2 Demo', slug: SLUG }) });
    if (made.status !== 201) throw new Error(`could not create ${SLUG}: ${made.status} ${JSON.stringify(made.body)}`);
    console.log(`created ${SLUG}`);
}
