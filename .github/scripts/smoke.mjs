// Smoke test of the production images, as `docker compose up` runs them.
//
//   docker compose up --build --wait
//   node .github/scripts/smoke.mjs
//
// One pass along the path the product exists for: a person signs up, makes a
// project, a site posts an error with its key, and the error shows up as an
// issue. Plus what only a production build can get wrong: static files, the SPA
// fallback, and the discovery file the extension reads.
const API = process.env.SMOKE_API ?? 'http://localhost:3000';
const WEB = process.env.SMOKE_WEB ?? 'http://localhost';

let failed = 0;
const check = (name, pass, detail = '') => {
    if (!pass) failed++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const request = async (url, { token, body, headers, ...init } = {}) => {
    const res = await fetch(url, {
        ...init,
        headers: { ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }), ...headers },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        /* not JSON */
    }
    return { status: res.status, headers: res.headers, text, json };
};

const health = await request(`${API}/api/health`);
check('API is up and connected to its database', health.json?.app === 'apexops' && health.json?.database === 'connected', health.text.slice(0, 120));

const sdk = await request(`${API}/sdk/v1.js`);
check('API serves /sdk/v1.js, loadable cross-origin', sdk.status === 200 && sdk.headers.get('cross-origin-resource-policy') === 'cross-origin', `status ${sdk.status}`);

const discovery = await request(`${WEB}/apexops.json`);
check(
    'web serves /apexops.json naming the API, readable cross-origin',
    discovery.json?.apiUrl === API && discovery.headers.get('access-control-allow-origin') === '*',
    discovery.text.slice(0, 120),
);

const deep = await request(`${WEB}/p/anything/issues`);
check('web answers a deep link with the app', deep.status === 200 && deep.text.includes('<div id="root"'), `status ${deep.status}`);

const run = Date.now().toString(36);
const account = { email: `smoke-${run}@example.test`, password: `Smoke-${run}-Pass1`, firstName: 'Smoke' };
const registered = await request(`${API}/api/auth/register`, { method: 'POST', body: account });
check('register', registered.status === 201, `status ${registered.status}`);

const login = await request(`${API}/api/auth/login`, { method: 'POST', body: { email: account.email, password: account.password } });
const token = login.json?.accessToken;
check('sign in', !!token, `status ${login.status}`);

const project = await request(`${API}/api/projects`, { method: 'POST', token, body: { name: `Smoke ${run}` } });
check('create a project', project.status === 201 && !!project.json?.ingestKey, `status ${project.status}`);

const message = `smoke error ${run}`;
const ingest = await request(`${API}/api/ingest`, {
    method: 'POST',
    headers: { 'X-Apexops-Key': project.json?.ingestKey ?? '', Origin: 'https://site-under-test.example' },
    body: { events: [{ level: 'error', message }] },
});
check('a site posts an error with the project key', ingest.status === 202, `status ${ingest.status} ${ingest.text.slice(0, 120)}`);

let found = null;
for (let i = 0; i < 20 && !found; i++) {
    const list = await request(`${API}/api/projects/${project.json?.slug}/issues?limit=5`, { token });
    found = list.json?.issues?.find((issue) => issue.title.includes(message)) ?? null;
    if (!found) await new Promise((r) => setTimeout(r, 500));
}
check('...and it appears as an issue', !!found, found ? `issue ${found.id}` : 'not listed after 10s');

const anonymous = await request(`${API}/api/projects`);
check('control: without a token the API refuses', anonymous.status === 401, `status ${anonymous.status}`);

console.log(failed ? `\n${failed} smoke check(s) failed` : '\nsmoke passed');
process.exit(failed ? 1 : 0);
