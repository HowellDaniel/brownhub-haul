# BrownHub Haul Reliability, Studio Palette, Email and Airport Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix silent account access, apply Studio colours throughout Haul, add non-blocking Resend receipts and accessible licensed airport video, and prepare durable hosting without making unverified production claims.

**Architecture:** Keep the zero-dependency Node/browser-module application. Account mounting moves ahead of booking initialization; brand sync supplies every semantic colour token; a server-only mailer runs after manifest persistence; the existing motion module progressively enhances poster images with local video. Render Starter and its `/data` disk provide production durability only after the user-paid infrastructure change is active.

**Tech Stack:** Node.js 24, `node:http`, browser ES modules, CSS custom properties, Chrome/CDP, Swift/WKWebView, Resend HTTPS API, Render Blueprint.

**Spec:** `docs/superpowers/specs/2026-11-07-haul-reliability-brand-email-media-design.md`

## Global Constraints

- Preserve Poppins, the cinematic landing page, liquid glass, booking/tracking/dispatch/account behavior and the Studio `haul.html` opening journey.
- Never print or commit credentials, session tokens, dispatch tokens, handover PINs or `.env` files. Never store a readable PIN in manifests, account history, email or localStorage.
- Test email with loopback stubs only. Never send validation probes to live booking, account or email-mutation endpoints.
- Keep Chrome profiles and throwaway databases outside the repository; use the existing `.verify` harness cleanup conventions.
- Do not commit, push, deploy, change the paid Render plan or configure Resend without explicit action-time authorization. L3 deep review must pass before any push/deploy.
- Existing files are edited in place. New files are limited to the mailer, focused regression harnesses, licensed media and their source records.
- Run the Node executable available on this Mac, normally `/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node`; no `package.json` or dependency install is required.

## File Structure

- `app/js/main.mjs` — boot ordering and independent account mounting.
- `core/brand.mjs` — Studio-to-Haul semantic token mapping.
- `styles/app.css` — palette consumption and responsive media treatment.
- `core/email.mjs` — server-only Resend receipt composition and delivery result.
- `server.mjs` — post-persistence mailer invocation and public email status.
- `app/js/booking.mjs`, `index.html` — confirmation email status and video markup.
- `app/js/motion.mjs` — reduced-motion-aware lazy video enhancement.
- `render.yaml` — durable account/key paths and non-secret Resend environment declarations.
- `assets/` — licensed local video and posters; `assets/MEDIA-SOURCES.txt` records provenance.
- `sw.js` — shell revision and local poster/media cache policy.
- `.verify/login-offline.mjs`, `.verify/email.mjs`, `.verify/media.mjs` — focused new regressions.
- Existing `.verify/*.mjs` suites — regression and real-browser evidence.

---

### Task 1: Keep account controls usable when booking configuration fails

**Files:**
- Modify: `app/js/main.mjs:15-39`
- Test: `.verify/login-offline.mjs`

**Interfaces:**
- Consumes: existing `mountAccounts()`, `api.account()`, `#login-open`, `#account-modal`, `#account-status`.
- Produces: `boot()` mounts account controls exactly once before awaiting `api.config()` and `api.places()`; offline booking behavior remains unchanged.

- [ ] **Step 1: Write the failing offline-login browser test**

Create `.verify/login-offline.mjs` from the existing `.verify/account-ui.mjs` spawn/CDP pattern. Start Haul with a throwaway `DB`, `BROWN_OFFLINE=1` and test-only `HAUL_TOKEN`. Use CDP request interception to fail only local `/api/config` and `/api/places`; leave `/api/account` reachable. The central assertion is:

```js
await s.navigate(`${base}/#/book`);
await waitFor(`!document.querySelector('#offline').hidden`, "offline notice");
await s.click("#login-open");
await waitFor(`!document.querySelector('#account-modal').hidden`, "login dialog while booking engine is unavailable");
check("login opens during booking configuration failure", await s.eval(`!document.querySelector('#account-modal').hidden`));
check("the login form is operable", await s.eval(`!document.querySelector('#login-submit').disabled && !!document.querySelector('#login-email')`));
```

Add an API-stub variant that returns 503 from `/api/account`, submits the form, and asserts `#account-status` becomes visible with the server message. Clean up the server, Chrome and scratch directory in `finally`.

- [ ] **Step 2: Run the test and verify RED**

Run: `/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/login-offline.mjs`
Expected: FAIL at `login dialog while booking engine is unavailable`; the modal remains hidden because `boot()` returns before `mountAccounts()`.

- [ ] **Step 3: Make the minimal boot-order change**

Move account mounting ahead of the configuration request while leaving booking mount after successful configuration:

```js
export async function boot() {
  $("#year").textContent = String(new Date().getFullYear());
  mount("account", mountAccounts);
  let config;
  try {
    [config, places] = await Promise.all([api.config(), api.places()]);
  } catch (e) {
    $("#offline").hidden = false;
    $("#api-host").textContent = location.origin;
    console.error("[haul] engine unreachable:", e);
    return;
  }
  window.__HAUL = config;
  window.__HAUL_CONTACT = config.contact;
  paintChrome(config);
  wireScrollLinks();
  mount("book", () => mountBooking(config));
  route();
  window.addEventListener("hashchange", route);
  window.addEventListener("haul:track", (e) => {
    location.hash = `#/track/${e.detail}`;
  });
}
```

Remove the later duplicate `mount("account", mountAccounts)` line. Do not change account API behavior.

- [ ] **Step 4: Verify GREEN and existing account behavior**

Run:
```bash
/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/login-offline.mjs
/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/auth.mjs
/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/account-ui.mjs
```
Expected: the new offline checks pass; existing account API reports 22/22 and account UI reports 11/11.

---

### Task 2: Make the full visible palette Studio-derived

**Files:**
- Modify: `core/brand.mjs:289-322`
- Modify: `styles/app.css`
- Test: `.verify/brand.mjs`
- Test: `.verify/login-offline.mjs` for no-regression account access

**Interfaces:**
- Consumes: Studio `bg`, `surface`, `border`, `text`, `text-muted`, `accent`, `accent-fill-hover`, `accent-2`, `radius`.
- Produces: dynamic `--night`, `--night-2`, `--night-3`, `--gold`, `--gold-2`, `--ice` in addition to existing tokens; no independent navy/gold defaults survive in visible components.

- [ ] **Step 1: Add failing token and computed-style assertions**

In `.verify/brand.mjs`, extend `look` to read the six added variables plus computed `body`, `.hero`, `.topbar-in`, `.airports`, `.booking-section`, `.account-modal` and footer colors. Add assertions shaped as:

```js
check("dark surfaces derive from Studio text, not navy", look.night === "#0b1a24" && look.bodyBg === "rgb(11, 26, 36)", look);
check("highlight ramp derives from Studio bronze", look.gold.includes("color-mix") && look.gold.includes("#7c4a12"), look.gold);
check("hero and navigation contain no independent navy", !/7,\s*18,\s*31|17,\s*28,\s*41|20,\s*39,\s*57/.test(`${look.heroBg} ${look.navBg}`), look);
check("light booking glass remains Studio-derived", !/eaf5fa|f2f8fb|e8f3f8/i.test(look.bookingBg), look.bookingBg);
```

For the production Studio fixture also assert `#1b0b0c/#26100f/#331517`-equivalent mixes and bronze highlights; do not hard-code production colors into the dynamic-feed test.

- [ ] **Step 2: Run the brand suite and verify RED**

Run: `/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/brand.mjs`
Expected: FAIL because `--night` remains `#07121f`, `--gold` remains `#f3c969`, and body/hero/navigation retain blue literals.

- [ ] **Step 3: Extend the semantic token map**

Add these mappings in `appTokens(brand)`:

```js
"--night": `color-mix(in srgb, ${t.text} 68%, #000)`,
"--night-2": `color-mix(in srgb, ${t.text} 82%, #000)`,
"--night-3": t.text,
"--gold": `color-mix(in srgb, ${t["accent-2"]} 58%, ${t.surface})`,
"--gold-2": t["accent-2"],
"--ice": `color-mix(in srgb, ${t.border} 55%, ${t.surface})`,
```

Use the same formulas in the stylesheet fallback with the bundled Studio colors, so direct static rendering and injected rendering share one ramp. Keep status green/amber/red semantic rather than forcing them into brand accent colors.

- [ ] **Step 4: Replace hard-coded visible blue/gold values component by component**

Edit `styles/app.css` in small passes: root/body/glass/chrome; hero/quick booking/marquee; airport/arrival/journey/fleet/footer; booking/track/dispatch/account modal; responsive overrides. Replace color literals with `var(--night*)`, `var(--gold*)`, `var(--ice)`, `rgba(var(--brown-rgb),…)`, `rgba(var(--red-rgb),…)` or `color-mix()` with those tokens. In particular, change the booking gradient's `#eaf5fa/#f2f8fb/#e8f3f8` admixtures to `var(--ice)` and `var(--card)`. Replace the hero CTA's independent yellow gradient with `linear-gradient(135deg,var(--gold),var(--gold-2))` and use `var(--night)` for its text. Preserve dimensions, layout, blur, radii and interaction timing.

After each pass use the Grep tool on `styles/app.css` with this case-insensitive pattern:

```text
#(?:07121f|0b1a2a|102338|111c29|091522|0d1e30|152638|142639|f3c969|d9aa46|eaf5fa|f2f8fb|e8f3f8)|243,201,105|49,89,118
```

Expected after the final pass: no matches. Do not alter SVG illustrations in `index.html` during this task; their internal fixed colors are part of labelled diagram artwork, not dynamic UI tokens.

- [ ] **Step 5: Verify computed styles and visual behavior**

Run:
```bash
/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/brand.mjs
/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/login-offline.mjs
/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/webkit.mjs
```
Expected: all dynamic-token checks pass at desktop and mobile sizes; existing brand and WebKit assertions stay green. Capture fresh 1440 px and 390 px screenshots and inspect hero, booking, account and tracking surfaces for contrast, clipping and preserved glass.

---

### Task 3: Send a safe booking receipt without making email a booking dependency

**Files:**
- Create: `core/email.mjs`
- Modify: `server.mjs:20-43,368-381`
- Modify: `app/js/booking.mjs:227-263`
- Modify: `index.html` confirmation modal
- Modify: `render.yaml`
- Modify: `README.md` deployment/email section
- Test: `.verify/email.mjs`
- Test: `.verify/account-ui.mjs`

**Interfaces:**
- Consumes: `store.create()` result, public shipment view, request origin, `RESEND_API_KEY`, `RESEND_FROM`, `PUBLIC_BASE_URL`.
- Produces: `createBookingMailer({ apiKey, from, fetchImpl, endpoint }) → mailer.sendReceipt(shipment, trackingUrl)`; response field `email: { attempted, delivered, message }`; `#conf-email` status.

- [ ] **Step 1: Write failing mailer and API tests**

Create `.verify/email.mjs` using `node:http` for a loopback Resend stub. Test the pure receipt and the full booking route with a throwaway DB:

```js
const receipt = bookingReceipt(publicShipment, "https://haul.example/#/track/BH-7K2M9X");
assert.match(receipt.subject, /BH-7K2M9X/);
assert.match(receipt.text, /Track your haul/);
assert.doesNotMatch(receipt.text + receipt.html, /handover PIN\s*[:=]?\s*\d{4}/i);

const created = await postBooking({ customerEmail: "ama@example.test" });
assert.equal(created.res.status, 201);
assert.equal(created.data.email.attempted, true);
assert.equal(created.data.email.delivered, true);
assert.equal(stub.messages.length, 1);
assert.equal(stub.messages[0].to[0], "ama@example.test");
assert.ok(stub.messages[0].html.includes("/#/track/" + created.data.code));
assert.ok(!JSON.stringify(stub.messages[0]).includes(created.data.pin));
```

Repeat with no email, stub 500, missing API key and provider timeout. Assert no-email returns `attempted:false`, and every provider/configuration failure still returns HTTP 201, preserves the tracking code/PIN response and includes a user-safe warning. Restart the local server with the same DB and assert the booking/account history remains present. Never use `api.resend.com` in this harness.

- [ ] **Step 2: Run the test and verify RED**

Run: `/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/email.mjs`
Expected: FAIL because `core/email.mjs` and the booking response's `email` field do not exist.

- [ ] **Step 3: Implement the server-only receipt module**

Implement `bookingReceipt(shipment, trackingUrl)` with escaped HTML and a plain-text alternative. Include brand/booking code, traveller name, route, pieces/weight, collection date/window, total, tracking anchor and payment-at-collection reminder. Do not include email credentials, account internals, `pin`, `pinSeal` or raw request objects.

Implement `createBookingMailer()` with an injectable `fetchImpl`, default endpoint `https://api.resend.com/emails`, an 8-second `AbortSignal.timeout()`, and these outcomes:

```js
{ attempted: false, delivered: false, message: "Add an email address next time to receive a receipt." }
{ attempted: true, delivered: true, message: `Receipt sent to ${email}.` }
{ attempted: true, delivered: false, message: "Your booking is confirmed, but the receipt email could not be sent. Keep your tracking code." }
```

Do not log API keys, provider response bodies or message contents. Catch fetch/abort errors and return the warning rather than throwing.

- [ ] **Step 4: Integrate delivery after persistence**

At server startup construct the mailer from environment variables. After `store.create()` succeeds, build the public view, create an absolute tracking URL from validated `PUBLIC_BASE_URL` or the request's forwarded/host origin, await the mailer only when an email address exists, and return:

```js
return send(res, 201, {
  ok: true,
  ...publicShipment,
  pin: result.pin,
  email: emailStatus,
});
```

The plaintext PIN remains restricted to this one booking response. Add `#conf-email` to the confirmation modal and render `s.email.message` with `textContent`; use a warning class only for `attempted && !delivered`. Extend `.verify/account-ui.mjs` to assert the local no-email state and ensure no email/PIN data enters localStorage.

- [ ] **Step 5: Declare configuration without secrets and verify GREEN**

Add Render declarations for `RESEND_API_KEY` (`sync: false`), `RESEND_FROM` (`sync: false`) and `PUBLIC_BASE_URL` (`value: https://brownhub-haul.onrender.com`). Add `ACCOUNTS_DB=/data/accounts.json` and `HAUL_SECRET=/data/secret.key` after confirming the actual secret environment name in `core/lockbox.mjs`; use that exact name rather than inventing one. Document dashboard-only setup and sender verification in `README.md`.

Run:
```bash
/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/email.mjs
/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/auth.mjs
/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/account-ui.mjs
```
Expected: delivered, skipped and failed-email cases pass; all bookings persist and existing account checks remain green.

---

### Task 4: Add licensed slow airport video with static accessible fallbacks

**Files:**
- Create: `assets/airport-hero.mp4`, `assets/airport-terminal.mp4`, `assets/airport-apron.mp4` and optimized posters if needed
- Create: `assets/MEDIA-SOURCES.txt`
- Modify: `index.html` hero and airport figures
- Modify: `styles/app.css`
- Modify: `app/js/motion.mjs`
- Test: `.verify/media.mjs`

**Interfaces:**
- Consumes: `[data-airport-video]`, existing reduced-motion/fine-pointer media queries and `.image-zoom`/`.airport-photo` containers.
- Produces: lazy source attachment, `playbackRate=0.65`, offscreen pause, poster-only reduced-motion/save-data behavior and subtle CSS 3D transforms.

- [ ] **Step 1: Write failing media regression checks**

Create `.verify/media.mjs` with the existing CDP harness. Assert three local videos have muted/loop/playsinline/preload-none/poster/dimensions; no remote media is requested; reduced-motion and emulated save-data clients have no `src` attached and show posters. In the normal desktop client, scroll each into view and assert:

```js
await waitFor(`document.querySelector('[data-airport-video]').readyState >= 2`, "hero video metadata");
check("airport footage plays slowly", await s.eval(`[...document.querySelectorAll('[data-airport-video]')].filter(v => v.currentSrc).every(v => v.playbackRate === 0.65)`));
check("video is muted and inline", await s.eval(`[...document.querySelectorAll('[data-airport-video]')].every(v => v.muted && v.playsInline)`));
check("posters reserve layout before playback", await s.eval(`[...document.querySelectorAll('[data-airport-video]')].every(v => v.getBoundingClientRect().height > 100)`));
```

Also assert offscreen video pauses, mobile widths have no horizontal overflow, and reduced-motion CSS disables video transforms/tilt.

- [ ] **Step 2: Run the test and verify RED**

Run: `/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/media.mjs`
Expected: FAIL because `[data-airport-video]` does not exist.

- [ ] **Step 3: Source and record licensed footage**

Download three real airport/terminal/apron clips from sources whose license explicitly permits commercial website use and redistribution. Save only local compressed MP4 assets and poster images. Record exact source page, creator, license name/URL, download date and any required attribution in `assets/MEDIA-SOURCES.txt`. Do not label generic footage as a live or actual view of Kotoka, Kumasi or Tamale. Keep existing real Ghana airport photographs and labelled SVG studies; video is atmospheric enhancement.

- [ ] **Step 4: Add poster-first markup and styling**

Use this shape, with the relevant local asset/poster and dimensions for each figure:

```html
<video class="airport-motion" data-airport-video
  data-src="assets/airport-terminal.mp4"
  poster="assets/kotoka-terminal.jpg" width="1100" height="825"
  muted loop playsinline preload="none" aria-hidden="true"></video>
```

Keep the existing image as the poster fallback where practical. Style video exactly over the figure with `object-fit:cover`, stable aspect ratio and no pointer events. Apply only small perspective/scale transforms on fine-pointer, full-motion clients; keep text and controls untransformed.

- [ ] **Step 5: Implement progressive playback**

In `motion.mjs`, return early for `reduced.matches`, `navigator.connection?.saveData`, missing `HTMLVideoElement`, or a constrained `hardwareConcurrency <= 2`. Otherwise observe videos with a generous root margin, assign `src = dataset.src` only near the viewport, set `playbackRate = 0.65` on `loadedmetadata`, call `play()` only while visible, and pause when offscreen or `document.hidden`. Catch autoplay rejection and leave the poster visible. Do not create another animation framework or change existing reveal/counter behavior.

- [ ] **Step 6: Verify normal, mobile and constrained media**

Run:
```bash
/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/media.mjs
/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/webkit.mjs
```
Expected: real playback is proven in Blink, reduced-motion/save-data use posters, no remote media requests occur, desktop/mobile layouts do not overflow, and WebKit regressions stay green.

---

### Task 5: Prepare durable hosting and prove only the persistence actually available

**Files:**
- Modify: `render.yaml`
- Modify: `README.md`
- Test: `.verify/auth.mjs`
- Test: `.verify/email.mjs`

**Interfaces:**
- Consumes: `/data/shipments.json`, `/data/accounts.json`, `/data/photos`, `/data/brand.json`, the existing PIN-sealing key.
- Produces: one Blueprint whose paid disk holds every mutable traveller/operations record and whose non-secret email settings are explicit.

- [ ] **Step 1: Add a failing deployment-configuration assertion**

Add to `.verify/email.mjs` a YAML text assertion that all mutable paths share `/data` and Resend secrets are not values:

```js
const blueprint = await readFile(join(ROOT, "render.yaml"), "utf8");
for (const path of ["/data/shipments.json", "/data/accounts.json", "/data/photos", "/data/brand.json", "/data/secret.key"])
  assert.ok(blueprint.includes(path), `missing durable path ${path}`);
assert.match(blueprint, /key:\s*RESEND_API_KEY\s*\n\s*sync:\s*false/);
assert.doesNotMatch(blueprint, /key:\s*RESEND_API_KEY\s*\n\s*value:/);
```

- [ ] **Step 2: Run and verify RED, then update the Blueprint**

Run the email harness and confirm the new configuration assertion fails. Edit only the exact environment names used by the application, retain `plan: starter`, `autoDeployTrigger: "off"`, the 1 GB disk and generated dispatch token, then rerun until green.

- [ ] **Step 3: Document backup and cutover evidence**

Add a short runbook to the existing deployment section: export/download accessible current `shipments.json`, `accounts.json`, photo directory and PIN-sealing key through Render's available shell/disk mechanism before changing plans; store the backup privately outside Git; apply the Blueprint; restore only if the new disk is empty; deploy the reviewed commit; create a local/test booking only in an approved non-production check; restart and verify account login/history. Never print the key or customer records in logs. If Render Free exposes no shell/data download, record that limitation and request an authorized dashboard export rather than claiming a backup occurred.

- [ ] **Step 4: Verify local restart behavior without overstating production**

Run `.verify/auth.mjs` and `.verify/email.mjs`. Expected: accounts/bookings survive a local server restart and configuration checks pass. Report production durability as pending until the actual Starter service and mounted disk are active and a real restart check has evidence.

---

### Task 6: Refresh the offline shell and run the complete release gate

**Files:**
- Modify: `sw.js`
- Modify: `.verify/pwa.mjs` only if its expected version/shell list requires the new assets
- Verify: all files changed above

**Interfaces:**
- Consumes: completed shell, modules, styles and poster assets.
- Produces: `brownhub-haul-v5`; no API, photo, email or account-response caching.

- [ ] **Step 1: Add failing worker assertions**

Update the PWA regression to expect `v5` and the new poster assets. Assert video MP4s are not required for installation and are not cached by the worker, so constrained/offline devices do not download large media:

```js
assert.match(workerSource, /const VERSION = "v5"/);
assert.ok(!/\.mp4/.test(workerSource));
assert.match(workerSource, /url\.pathname\.startsWith\("\/api\/"\)/);
```

Run `.verify/pwa.mjs` and confirm it fails on `v4` before changing the worker.

- [ ] **Step 2: Bump the worker and verify installability**

Change only `const VERSION = "v4"` to `"v5"` and add essential local posters to `SHELL` if new posters were introduced. Keep all static shell requests network-first and exclude `api/` and `photos/`. Run:

```bash
/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node .verify/pwa.mjs
```
Expected: all installability, offline-shell and cache-isolation checks pass.

- [ ] **Step 3: Run every existing and new regression fresh**

```bash
NODE=/Users/brownhub/tools/node-v24.22.0-darwin-arm64/bin/node
$NODE .verify/login-offline.mjs
$NODE .verify/auth.mjs
$NODE .verify/account-ui.mjs
$NODE .verify/email.mjs
$NODE .verify/brand.mjs
$NODE .verify/media.mjs
$NODE .verify/ui.mjs
$NODE .verify/overflow.mjs
$NODE .verify/studio-nav.mjs
$NODE .verify/webkit.mjs
$NODE .verify/pwa.mjs
```

Read every exit code and failure count. Inspect fresh desktop/mobile screenshots and browser exception logs. Do not infer success from a partial run.

- [ ] **Step 4: Review the diff and requirement checklist**

Confirm: login opens during configuration failure; visible UI uses dynamic Studio colors; email excludes PIN and cannot roll back a booking; accounts/bookings use durable paths; video is licensed/local/slow/lazy/muted with posters; shell version changed; no secrets or production data are staged; Studio `haul.html` navigation remains unchanged.

- [ ] **Step 5: Run L3 before any handoff**

After all intended changes are committed under separately authorized release work, run the required L3 deep review. A cancelled or unavailable review is not clean and blocks push/deploy. Do not combine commit and push commands. Only after explicit action-time approval, a clean L3 result and fresh green tests may the reviewed commit be pushed or deployed.

- [ ] **Step 6: Verify any authorized production release**

Verify the deployed app revision, offline-engine account behavior where safely reproducible without live mutations, Studio colors, media playback/fallbacks and public Studio-to-Haul journey. Test email only through Resend's dashboard or an explicitly authorized real booking recipient; never create disposable live bookings merely to probe email. Confirm Render plan/disk and persistence from dashboard/runtime evidence before claiming durable records.
