# BrownHub Haul — luggage, handled

Collect a traveller's bags at a home or office in Accra, move them on the same
manifest as everybody else's, and hand them over at Kotoka, a hotel, another
city — or a desk in Lagos — against a four-digit PIN.

Haul is not its own brand. It is **an app of BrownHub Studio**: at boot it reads
the studio's identity — name, palette, address, hours, phone, WhatsApp, logo —
from [brownhub283.com](https://www.brownhub283.com/), and the shell is served
with the studio's colour tokens already in the first paint. The site also has a
luggage page (`web/haul.html`) so the studio presents the service it actually
runs. If the site is unreachable the last good identity is used, then a bundled
copy; the app always boots.

Three screens, one machine, no build step:

| View | Who uses it | What it does |
| --- | --- | --- |
| `#/book` | traveller / WhatsApp desk | live quote while the form is filled, then a tracking code + handover PIN and a pre-written WhatsApp message back to the depot |
| `#/track/BH-XXXXXX` | traveller | the six-stage status ladder, ETA, driver, price, and any photo the depot attached to their own bag — shareable URL, refreshes itself every 45 s until delivered |
| `#/dispatch` | the depot, behind a passphrase | today's manifest, seven stat tiles, status filter, search, one-click advance, delay/resume, handover-PIN check, camera capture at the door |

## Run it

Node 18+ and nothing else. No `npm install`, no framework, no database server —
the manifest is a JSON file written atomically.

```sh
node server.mjs                      # http://127.0.0.1:8420
open http://127.0.0.1:8420           # or double-click start.command on the depot Mac
```

On the depot machine, `start.command` finds Node, starts the server, waits for
`/api/health` and opens the browser.

Environment:

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8420` | |
| `HOST` | `127.0.0.1` | set `0.0.0.0` to reach it from the depot phones (see *Security*) |
| `DB` | `data/shipments.json` | absolute or relative to this folder |
| `HAUL_TOKEN` | generated | the dispatch passphrase. With no `HAUL_TOKEN` the server mints one and **prints it once** on first boot — write it down there, because only its HMAC goes on disk and it cannot be recovered later. Set it again to rotate: `HAUL_TOKEN='new phrase' node server.mjs` |
| `PHOTOS` | `data/photos` | where custody photos are written; lives next to the manifest unless you move it |
| `BROWN_SITE` | `https://www.brownhub283.com/` | the studio site the identity is read from; `off` skips the network entirely |
| `BRAND_CACHE` | next to the manifest (`brand.json`) | the last good identity, written `0600`; reused when the site is down |
| `BROWN_OFFLINE` | unset | `1` = never touch the network, use the cache or the bundled values |

## Install it on a phone (no app store)

The same page is a PWA. `site.webmanifest`, `sw.js` and `assets/icons/` give it:

* **Android / desktop Chrome, Edge, Samsung Internet** — an **Install app** pill in
  the header, wired to `beforeinstallprompt`, so the browser's own install dialog
  does the work.
* **iPhone / iPad** — the pill opens the Safari recipe (**Share → Add to Home
  Screen**). Chrome and Firefox on iOS are WebKit but cannot add to the home
  screen, so there the sheet says to open the page in Safari first.
* **Installed** — `display: standalone`, no address bar, and the booking shell is
  cached by `sw.js` so a cold start in a basement car park still paints the form.

The worker is deliberately narrow: navigations are network-first with the cached
shell as the fallback, static files are stale-while-revalidate, and **`/api/` and
`/photos/` are never cached** — a manifest, a handover PIN or a traveller's face
must not outlive the screen that showed it. Bump `VERSION` in `sw.js` when a shell
file changes; `activate` drops every older cache.

Installation requires **HTTPS** (or localhost). A plain-HTTP LAN address gets no
service worker and no install prompt, which is why the app needs a real host —
see `web/DEPLOY.md`.

## Whose app this is (the studio sync)

`core/brand.mjs` resolves one identity at boot, in this order, and never throws:

1. **`/data/haul.json`** on the studio site — the explicit contract (`web/haul.json`
   in this repo is the file to publish). It wins when present.
2. **The published pages** — `/llms.txt` (name, e-mail, phones, WhatsApp, address,
   hours, services), `/css/style.css` (`html[data-theme="light"]` → `:root` tokens),
   and the homepage (`alternateName` / `apple-mobile-web-app-title` / `og:site_name`)
   for the display name.
3. **`brand.json`** beside the manifest — the last identity that worked.
4. **The bundled `FALLBACK`** in `core/brand.mjs` — current studio values.

`BRAND_SYNC` is awaited by `/api/health`, so the first request cannot race it. The
served `index.html` has `<!--BRAND-->` replaced with a `<style id="brand-tokens">`
block (`--paper`, `--red`, `--brown`, `--r` …), which is why there is no flash of
the app's old palette and no client fetch before paint. `--r-s` is
`calc(var(--r) - 4px)`, so the studio's corner radius reaches the components.

As of 2026-10-28 the feed is live: `brownhub283.com/data/haul.json` and
`brownhub283.com/haul.html` are published, and a boot log reads
`[brand] … source: haul.json`. Commit `bf59208` published the feed-driven nav
(`js/nav.js?v=12`, studio cache `v98`). Commit `e47d999` briefly pointed
`haul.app` at a Cloudflare quick tunnel; that hostname died with its process, and
commit `d3dbca8` removed it and made the nav and `haul.html` reject
`*.trycloudflare.com`. **`haul.app` is empty today, so Luggage opens
`haul.html` — the page — not the app.** `.verify/studio-nav.mjs` proves the
feed-driven rewrite and the shipped value's rules — 27/27.

The app itself runs from `node server.mjs`. To put it on the site, deploy it to
a host with a persistent disk and set one line in `data/haul.json`; no code
change. The repository now carries `Dockerfile`, `render.yaml`, `fly.toml` and
`deploy/` (nginx vhost and systemd unit), and `web/DEPLOY.md` step 3 has the
commands. This Mac has no hosting account, provider CLI or SSH server, so the
deploy itself needs that one login or a VPS address.

Everything read from the network is treated as untrusted: colours must be `#rgb` /
`#rrggbb` / `rgb()`, lengths must be px/rem, links must be `http(s)`, text is
stripped and capped, and nothing is ever interpolated as a `url()` or raw HTML.
The studio block reaches the UI through `/api/config`; `app/js/main.mjs` builds the
parent strip, footer and title with DOM nodes, not `innerHTML`.

Because the app is meant to live *under* the studio site, every API and photo URL
in the browser is mount-relative (`api/config`, `photos/BH-…`), so a reverse proxy
at `/haul/` works unchanged. `web/DEPLOY.md` has the nginx block and the site-side
steps.

## Layout

```
core/      the domain, imported by BOTH the browser and the server
  pricing.mjs   quote(): distance bands, weight tiers, VAT, promos, minimum charge, SLA
  zones.mjs     places, haversine distance, road factor, tier bands
  store.mjs     statuses, validation, atomic JSON persistence, redacted views, demo seed
  lockbox.mjs   the per-install key, sealed PINs, the token HMAC  (Node only)
  codes.mjs     BH-XXXXXX codes and 4-digit PINs (browser-safe, no node: imports)
  brand.mjs     studio identity: feed → published pages → cache → bundled  (Node only)
server.mjs  node:http API + static host + photo store + brand-injected shell
sw.js       the installed app's offline shell (never caches API or photos)
site.webmanifest + assets/icons/   the installable face: 192/512/maskable/apple
app/js/     dom, api, booking, track, dispatch, install, main  (vanilla ESM)
styles/     app.css — fallback tokens, then the components
tools/      smoke.mjs (API contract)
Dockerfile  the whole app on a volume at /data (Node 24, no dependencies)
render.yaml / fly.toml   managed-host blueprints: disk, health check, TRUST_PROXY
deploy/     nginx vhost and systemd unit for a VPS
web/        the studio side: haul.html, haul.json (the contract to publish), DEPLOY.md
.verify/    real-browser harness (CDP + a compiled WebKit probe):
            brand.mjs, ui.mjs, pwa.mjs, overflow.mjs, tiles.mjs, webkit.mjs,
            studio-nav.mjs, webkit/probe.swift
data/       shipments.json — the manifest · photos/ — custody shots · secret.key — see *Security*
```

`core/pricing.mjs` is the whole business, in one place. The browser imports it to
preview the price as you type; the server imports the *same file* to re-quote on
write, and the re-quote is what gets stored. A traveller can never be shown one
number and charged another — `.verify/ui.mjs` asserts the two agree to the pesewa.

Anything under `core/` that the browser imports must not use `node:fs` — that is
why the code/PIN helpers live in `codes.mjs` rather than in `store.mjs`.

## The price

All figures are Ghana cedis and live in `CONFIG` in `core/pricing.mjs`.

```
base collection & handling          45
leg                                 tiered per km: 3.50 (≤60 km) · 2.20 (≤300) · 1.60 above
                                    distance = haversine × 1.35 road factor
weight                              first 5 kg free, then 2.00/kg ≤15 · 3.20/kg ≤25 · 4.50/kg above
extra pieces                        20 each (max 6 pieces, 40 kg)
fragile / white-glove               8% of handling
oversize                            45
transit cover                       3% of declared value, minimum 15, capped at 60,000
weekend collection                  12%
cross-border leg                    180
service tier                        Standard ×1 · Express ×1.45 · Same-day VIP ×1.9 + 60
promo                               BHHAUL10 (10%, max 100) · TRAVEL50 (flat 50)
minimum charge                      65 · VAT 15% on top
```

The multiplier applies to **freight only**. Transit cover is priced on the freight
subtotal but is not freight, so insuring a bag never inflates the service fee —
`tools/smoke.mjs` pins that (`insurance is priced, not multiplied`).

The SLA is derived, not asserted: `handlingHours` per tier plus `km / kmh`, and the
tier card's sentence is generated from the same number (`collectWithin()`), so the
copy cannot drift from the promise the quote makes.

## Statuses

`booked → collected → in_transit → arrived_hub → out_for_delivery → delivered`,
with `delayed` as an exception that resumes to `in_transit`. `delivered` is
terminal. A driver is assigned when the leg goes out for delivery.

Tracking codes are `BH-` + 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` —
no I/O/0/1, so a code read over the phone survives the trip. Codes are
case-insensitive on the way in.

## API

`x-haul-token: <passphrase>` (or `Authorization: Bearer …`) is what separates the
depot from everybody else. Nothing else in the app is secret.

| Method & path | Who | Purpose |
| --- | --- | --- |
| `GET /api/health` | anyone | liveness, shipment count, and whether the caller holds the passphrase |
| `GET /api/config` | anyone | contacts, pricing `CONFIG`, service tiers, status ladder, brand block |
| `GET /api/brand` | anyone | the resolved studio identity: parent, tokens, studio, haul, and which source won |
| `GET /api/places` | anyone | all places, split into origins and destinations |
| `GET`/`POST /api/quote` | anyone | price + SLA for a payload; `422` with per-field `errors` |
| `POST /api/shipments` | anyone | book; re-quotes server-side, `201` with code + the one PIN the traveller is allowed to see |
| `GET /api/shipments` | **token** | the whole manifest plus `stats` — publicly it is `401`, not an empty list |
| `GET /api/shipments/BH-XXXXXX` | anyone | one haul, redacted: no PIN, no e-mail, phone masked as `233535 ••• 460` |
| `GET /api/shipments/BH-XXXXXX` | **token** | the same haul with full contacts and the handover PIN unsealed |
| `PATCH /api/shipments/BH-XXXXXX` | **token** | `{status,note,by}` to advance · `{action:"exception",note}` to flag a delay |
| `PATCH /api/shipments/BH-XXXXXX` | anyone | `{action:"verify-pin",pin}` — the driver's check, throttled to 8 tries per code per 10 min per IP |
| `POST /api/shipments/BH-XXXXXX/photos` | **token** | a base64 JPEG/PNG, sniffed for real magic bytes, ≤3 MB decoded |
| `GET /photos/BH-XXXXXX/<file>` | anyone who has the URL | the photo itself: `no-store`, `cross-origin-resource-policy: same-origin` |

```sh
curl -s 'http://127.0.0.1:8420/api/quote?fromId=kokomlemle&toId=kotoka&weightKg=18&pieces=2&service=express&insurance=true&declaredValue=4500'
curl -s -H "x-haul-token: $HAUL_TOKEN" 'http://127.0.0.1:8420/api/shipments?status=in_transit'
```

## Check it

Every harness boots its own server on its own throwaway DB, so none of them touch
the live manifest, and each refuses to start if its ports are already taken (that
guard once caught a detached Chrome holding a port, which would otherwise make the
next run test the wrong app).

```sh
node server.mjs &                 # smoke talks to a running server
HAUL_TOKEN=… DB=… node tools/smoke.mjs   # 92 API assertions: price rules, lifecycle,
                                # PIN sealing, photo store, throttle, static-file security
node .verify/ui.mjs               # 67 browser assertions (Blink): real clicks, a real
                                # <input type=file>, locked → refused → unlocked board
node .verify/overflow.mjs         # layout probe at 390 and 320 px on all three routes,
                                # with the board unlocked and a row holding a photo
node .verify/webkit.mjs           # 40 assertions in a compiled WKWebView probe — the only
                                # Safari-grade coverage available on this machine, with
                                # iPhone Safari and Chrome-iOS install recipes
node .verify/pwa.mjs              # 36 installability assertions: manifest parsed, no
                                # installability errors, worker scope/cache, offline shell,
                                # install prompt wiring, standalone, /haul/ mount
node .verify/brand.mjs            # 40 assertions: feed wins, computed style follows it,
                                # /haul/ reverse-proxy mount, scrape → cache → bundled fallback
node .verify/studio-nav.mjs       # 27 assertions: the studio's Luggage item follows
                                # haul.app in data/haul.json, on 16 pages and a journal
                                # post, with the feed served from a local fixture
node .verify/tiles.mjs            # element-targeted screenshots → .verify/shots/tiles
```

`studio-nav.mjs` reads the website repository (default
`../2026-09-16/5bb3bd1c`, override with `STUDIO_SITE=/path/to/brownhub-website`)
and serves it over a throwaway HTTPS origin, because the page CSP upgrades
insecure requests — an HTTP fixture would not reproduce what the live site does.

`tools/smoke.mjs` skips its four on-disk assertions unless `DB` points at the file
the server is actually writing, so set it when you want the manifest audit.

## Security notes

The threat model is a lost depot laptop, a manifest committed to a repo, or a
traveller's tracking URL forwarded to a friend. It is not a determined attacker on
the machine itself.

* **The dispatch board is a separate principal.** The manifest, every status change
  and the photo endpoint all require the passphrase. Without it the API answers
  `401` in a sentence and lists nothing — hiding the rows in CSS was not enough, so
  `.verify/ui.mjs` and `.verify/webkit.mjs` both assert the *network* is refused.
  The passphrase lives in `sessionStorage` (cleared on 401, so a rotated one cannot
  linger) — unlocked for the tab, locked again when the tab closes.
* **A tracking code is a capability URL**, deliberately shareable, so the public
  view of a haul is redacted by `publicView()`: no PIN, no `pinSeal`, no e-mail, and
  the phone as `233535 ••• 460`. The unredacted record only ever leaves the server
  behind the passphrase (`dispatchView()`).
* **Handover PINs are sealed, never stored readable.** `data/secret.key` (a
  per-install random 32 bytes, mode `0600`) keys AES-256-GCM; the manifest holds
  `pinSeal: "aes256gcm:iv.tag.ciphertext"`. A manifest written before this change is
  sealed on load and the plain `pin` key is deleted from the file. **If you lose
  `data/secret.key` the sealed PINs are unrecoverable** — the bags still deliver, but
  the desk has to re-issue a PIN. Keep it out of backups you do not encrypt and out
  of version control (it is git-ignored).
* **The passphrase itself is never on disk** — only its HMAC in `data.meta.tokenMac`,
  compared with `timingSafeEqual`. Leading or trailing whitespace in `HAUL_TOKEN` is
  trimmed on both sides of the comparison, so a token pasted from a terminal with a
  newline cannot lock the depot out of its own board.
* **PIN guessing is windowed**: 8 tries per code per 10 minutes per IP, then `429`
  with the wait spelled out. A 4-digit code on an unthrottled endpoint is a 3-hour
  afternoon of `curl`.
* **Photos are content-sniffed**, not trusted: the first bytes must be real JPEG or
  PNG magic, the decoded size is capped at 3 MB, the filename is generated (never the
  upload's), and `/photos/...` refuses encoded, double-encoded and normalised
  traversal. `tools/smoke.mjs` proves all of that. The browser shrinks a 12 MP camera
  shot to ≤1280 px JPEG before it is posted, so the depot's laptop does not fill up.
* Static files come from an **allowlist** (`index.html`, `styles/`, `app/`, `core/`,
  `assets/`) matched against the normalised, rooted path — matching the raw URL would
  let `/core/../server.mjs` through. `server.mjs`, `tools/`, `data/` and the photos
  directory are refused as files; the photos only serve through their own route.
* `HOST=127.0.0.1` by default. Opening `0.0.0.0` puts the board on the depot network —
  reachable, but still gated by the passphrase. The passphrase is a shared string, so
  treat it like one: it is the door code, not an account system.
* Behind the public tunnel the client address comes from `Cf-Connecting-IP` /
  `X-Forwarded-For`, trusted only when the peer is loopback or `TRUST_PROXY=1` is set
  for a platform proxy. PIN attempts are counted per client, and anonymous bookings
  are capped at 20 per client per ten minutes; the depot passphrase bypasses the cap.
  `/api/health` shows the token holder the absolute manifest path and everyone else
  only its basename.
* Markup is built with `textContent` and DOM nodes; the `html` helper in
  `app/js/dom.mjs` takes repo literals only (icons), never user or network text.
* The app never claims a photo exists. A stage note used to say *"Chain-of-custody
  photo taken"* for every haul; it now says what actually happened at the door, and
  the tracker shows the gallery only when the depot really attached shots.
  `.verify/ui.mjs` asserts the word "photo" does not appear on a photoless tracker.
* **The studio site is an input, so it is not trusted with code.** Brand sync only
  accepts validated colours/lengths, `http(s)` links and length-capped plain text;
  it never writes `url()` or markup, so a compromised or malformed `haul.json`
  cannot inject CSS or script — it degrades to the last good identity instead.
  `.verify/brand.mjs` exercises that whole ladder, including a dead site with no cache.

## Known limits

* One JSON file, one process. It is a depot tool, not a multi-tenant service.
* The public link is a quick tunnel to one Mac: no uptime guarantee, and the
  hostname changes when `cloudflared` restarts. It proves the install path; promote
  it to a real host before putting it on a business card.
* One shared passphrase for the whole desk — no per-operator accounts, so the
  history says `board`/`dispatch`, not a named person.
* Payment is a quote and a promise on WhatsApp. Nothing is charged here.
* The server accepts any `pickupWindow` string; only the form restricts windows to
  the selected tier's hours.
* Photo capture depends on the phone browser handing `<input capture>` to the camera;
  verified by feeding a real file through CDP, not by a physical phone.
* WebKit coverage is a compiled `WKWebView` probe (31 assertions, computed styles and
  geometry, real screenshots). It is not Safari: no real GPU compositing, and a
  check like `IntersectionObserver` never fires in an off-screen window. Firefox is
  untested entirely.
