# P5a hardening — safety and efficiency plan

Written 2026-09-28, after the P5a review (commit `4ef8ac6`). **Status 2026-11-27: H1–H4
built and merged into `ext/dev`** (ledger P5a-H1..H4). The §4 decisions took their defaults:
D1 needed no answer (the spike showed `setAccessLevel` works on `local`, Edge 158), D2 = (a)
with (b) as the fallback, D3 = the noisy site loses its own oldest first. Verified on Edge only.

## 1. System points — every place data crosses a boundary

Trust levels: **T0** = the web page (hostile by assumption). **T1** = a content
script running in the page's renderer (a compromised renderer can reach it).
**T2** = extension pages and the worker. **T3** = the ApexOps API.

| # | Point | From → to | What crosses | Current guard | Safety gap | Efficiency gap |
|---|---|---|---|---|---|---|
| S1 | `CAPTURE_EVENT` DOM event | T0 (MAIN capture) → T1 bridge | batch string | none (any page script can dispatch it) | none; S2 does the trusting | a page can dispatch without limit |
| S2 | `runtime.sendMessage({type:'ingest'})` | T1 bridge → T2 worker | batch string | `sender.id`, `sender.tab`, origin from `sender`, binding lookup, `sanitizeBatch` | — | each batch: `readBindings` + queue write + count write + flush, with **no per-tab rate limit** |
| S3 | ingest `POST` | T2 → T3 | events + ingest key | key from binding; flush is single in-flight | — | the queue cap (1000) is **global**, so one noisy site evicts other sites' events |
| S4 | popup `Request` | T2 popup → T2 worker | connect/disconnect/logout/credentials | `extensionPagePath !== null` and not `panel-*` | **default-allow**: any future extension page gets popup rights (review #5) | — |
| S5 | panel `PanelRequest` | T2 panel (framed in T0) → T2 worker | state, issues, switch, report, sign-in | path `/panel.html`, site from `sender.tab.url`, no destructive ops | page can trick clicks into **switch** and **report** (review #4); no CI test of R18 (review #1) | `panel-state` reads 4 stores on every open |
| S6 | `postMessage` panel ↔ toolbar | T2 ↔ T1, over T0's window | close / hide / visible / focus | `e.source === frame.contentWindow`, or `window.parent` | none (UI only, no data) | toolbar `message` listener attached for the whole page life (review #7) |
| S7 | `tabs.sendMessage(TOOLBAR_TOGGLE)` | T2 → T1 | toggle | `sender.id`, no `sender.tab` | — | — |
| **S8** | **`storage.local`** | T2 writes, **T1 reads** | **bindings with every site's ingest key, access and refresh tokens, apiUrl**, problems, prefs | none: `local` is readable by content scripts by default | **NEW, most severe — see §2** | every rotation fans out through `onChanged` to every bound tab |
| S9 | `storage.session` | T2 only (default) | ingest queue, tab counts | trusted contexts only (Chrome default) | — | count keyed by tab, not tab+origin (review #2); count write sits on the hot path (review #3) |
| S10 | content-script registration + `injectIntoTab` | T2 → T1 | bridge, capture, toolbar on bound origins | host permission per origin; top frame only | — | — |
| S11 | `web_accessible_resources: panel.html` | T0 can frame it | the panel | `use_dynamic_url`; site comes from `sender.tab` | a page that frames the panel gets `bound:false` (safe) | — |
| S12 | worker → API | T2 → T3 | bearer token, login password | `useApiOf` checks the stored API; login refuses a different server | `configureApi` is global state shared by concurrent popup and panel calls (safe today only because both check the same stored URL) | — |
| S13 | Alt+Shift+A command | user → T2 → T1 | toggle | active tab only | — | — |
| S14 | `POST /api/tickets` (server) | T3 | ticket | membership check → **400**, no role check | a viewer can file tickets; the panel's 403 branch is dead code (review #6) | — |

## 2. The new finding — S8, the storage trust boundary

P5a's own claim (X10) is that "nothing of ApexOps lives" in the toolbar. The code
says otherwise:

- `toolbar.content.ts:304` calls `readBindings()`. That returns the **whole map**:
  every bound site's `ingestKey`, not just this site's.
- `toolbar.content.ts:288` subscribes to `storage.onChanged` for `local`. That
  event carries every changed key's `newValue`. So **each token refresh sends the
  new access and refresh tokens into every bound tab's renderer** (the tokens are
  stored in `local` by `chromeStorageAdapter.ts`).

The page itself cannot read the isolated world. But a renderer exploit on any
bound site, including a hostile ad or dependency on the site under test, would get
long-lived API credentials for every project the user can reach. Chrome's
guidance is to keep secrets out of storage areas that content scripts can read.

Before P5a, content scripts did not *touch* storage, but they still had *access*
to it. So the full fix is to lock the area down, not only to stop reading it.

## 3. Phases — one phase, one branch, cut off `ext/dev`

Ordered by contract: H1 builds the tested router that H2 then adds a message class to.

### H1 — `ext/p5a-h1-router`: routing becomes a tested, default-deny function
Covers S4, S5, S14.
- Move the listener's decision into `lib/router.ts`:
  `route(message, sender, runtimeId) → 'ingest' | 'panel' | 'popup' | 'toolbar' | null`.
- Popup requests are allowed only from `path === '/popup.html'` (**allowlist**).
- Unit tests in `lib/router.test.ts` and `lib/panelRequests.test.ts`:
  - panel sender + `disconnect` or `logout` → null;
  - popup sender + `panel-*` → null;
  - foreign `sender.id` → null;
  - http `sender.url` → null;
  - unknown extension path → null;
  - unbound site → `{bound:false}` or `not-bound`;
  - slug regex rejects bad input;
  - report strips the query/hash and appends the `Page:` / `Tab title:` lines.
- Map the ticket `400 "Project not found"` to `no-access`. Remove the 403 branch.
- **Prove each test can fail**: break the allowlist on purpose, watch the test go red, restore.
- **Done when:** vitest green in CI; `p3`/`p4`/`p5a` checks still green.

### H2 — `ext/p5a-h2-storage`: nothing secret is readable from T1
Covers S8, S7. **Blocked on D1.**
- **Spike first (≤1 h).** Does `browser.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})` work on Chrome 131 and Edge 153? The typings list it for every area, but that support is *inferred*, not measured.
  - Check that can fail: from the toolbar content script, `storage.local.get()` must **reject**.
- The toolbar stops importing `bindings` and stops using `storage.onChanged`. Instead:
  - it asks the worker `{type:'toolbar-state'}` and gets back `{bound, pref}` only, for `sender.tab`'s origin;
  - drag and hide become `{type:'toolbar-pref', right, bottom, hidden}`; the worker writes them for the sender's origin only;
  - the worker pushes `toolbar-update` / `toolbar-unbound` with `tabs.sendMessage` to tabs on that origin.
- The worker calls `setAccessLevel` at startup (and `onInstalled`), before any other code runs.
- **Done when:**
  - the p5a check asserts `storage.local.get` rejects in the toolbar's world;
  - a token refresh produces **zero** messages in bound tabs;
  - drag, hide and show-again work across two tabs of the same site.

### H3 — `ext/p5a-h3-ingest`: the ingest hot path is bounded
Covers S1, S2, S3, S9. **D3 affects the fairness rule.**
- Key the count by `tabId|origin`. Reset a tab's count on `tabs.onUpdated` when `status === 'loading'`. Skip tabs with no id.
- Flush first; count after, fire-and-forget.
- Per-tab token bucket in the worker, applied **before** any storage read: 20 batches/s burst, 5/s sustained. Excess is dropped and counted in memory, never written.
- Cache bindings in memory; invalidate on `onChanged` for `BINDINGS_KEY`. This removes one storage read per batch.
- Per-origin queue share: no single origin may hold more than 50% of `MAX_QUEUED_EVENTS`, provided at least one other origin has events queued.
- **Measure before and after.** Baseline, then the target:
  - a page firing 1,000 capture events in 1 s → storage writes per second, API requests, worker CPU time;
  - target: at most 1 queue write per flush, and a flat request rate.
- **Done when:** `ingestQueue.test.ts` covers fairness; a new `tabCounts.test.ts` covers the navigation reset; the numbers are recorded in the ledger.

### H4 — `ext/p5a-h4-panel`: the panel resists borrowed clicks and stays quiet
Covers S5, S6. **Blocked on D2.**
- Gate switch and report behind the D2 choice.
- Attach the toolbar's `message` listener in `ensureFrame`; remove it in `teardown`.
- The Esc handler ignores events that are already `defaultPrevented`.
- Take priority levels from the server enum; stop copying them.
- **Done when:** the p5a check covers an overlay on top of the panel → the switch is refused; `message` listener count on a closed, never-opened toolbar is 0.

## 4. Decisions only you can make (each has a default)

- **D1 — if `setAccessLevel` does not work on `local`.** Either:
  - (a) move tokens and ingest keys into a store content scripts can't reach, e.g. `storage.session` mirrored to IndexedDB in the worker; or
  - (b) accept the residual risk, with nothing secret *read* in T1.
  - *Default: (a) for the refresh token only; the ingest keys stay (b).*
- **D2 — clickjacking gate.** Either:
  - (a) IntersectionObserver v2 `trackVisibility` (Chromium only; refuses clicks while the panel is covered); or
  - (b) a confirm step for switch; or
  - (c) both.
  - *Default: (a), with (b) as the fallback where v2 isn't supported.*
- **D3 — queue fairness.** Is a 50% per-origin cap right when you test two sites at once, or should the noisiest site simply lose its own oldest events first? *Default: 50%.*

## 5. Rollback and merge

- Each phase is its own branch, merged into `ext/dev` with `--no-ff` after its own check and all earlier checks pass.
- H2 changes the toolbar's data source. Revert it alone if the tabs misbehave: H1's router accepts a `toolbar` message class that nobody sends, which is harmless.
- Ledger: add P5a-H1..H4 rows to `feature-list.json` as `pending`. Mark one `done` only after its check has been seen to pass.
