# Publish BrownHub Haul on brownhub283.com

**Status: page and app both live; Luggage opens the app.** `haul.html`,
`data/haul.json`, the nav link, the services section and the sitemap entry were
published to `HowellDaniel/brownhub-website` `main` in commit `2f99429`
(2026-10-27). Commit `8723ede` made `haul.html` follow the studio's saved theme
(`js/theme.js`, light and dark). The app boots with `source: haul.json`.

Commit `bf59208` published the feed-driven nav. Commit `d3dbca8` removed a dead
Cloudflare quick tunnel and taught `haul.html` to reject `*.trycloudflare.com`.
`haul.app` now carries **`https://brownhub-haul.onrender.com/#/book`**, which
runs on Render (Docker, Frankfurt) and answers `/api/health`.

**Luggage opens `haul.html`, never the app.** `js/nav.js?v=13` no longer reads the
feed at all: both Luggage links stay on the page that describes the service, and
that page reveals its three "Open BrownHub Haul" buttons from `haul.app`. So the
app is one deliberate click away, from a page that first says what it is — and no
value in the feed can make a nav click start it.

**That service is on Render's free plan.** It sleeps after inactivity (the first
click after a quiet spell can wait ~50 seconds) and has no persistent disk, so
`/data` — the manifest, `secret.key` and photos — is wiped whenever the instance
restarts. Treat it as a live demo, not the booking system of record: it is enough
to prove the nav, the install prompt and the whole flow, but a real booking can
disappear. Step 3 upgrades the same code to Starter + a 1 GB disk, which ends
both limits. GitHub Pages cannot run the Node process, so the site only ever
links to it.

This folder holds the two files the studio site needs. Nothing here runs by itself —
copy them into the website repository (`HowellDaniel/brownhub-website`) and deploy
the way that repo already deploys (GitHub Pages, `main`).

| File here | Goes to | Why |
| --- | --- | --- |
| `haul.json` | `data/haul.json` | The contract the Haul app reads at boot: who the studio is, its palette, its contacts, and the Haul service block. One source of truth for both sides. |
| `haul.html` | `haul.html` (repo root) | The service page a visitor lands on: what Haul is, how a haul works, where it goes, and how to open the app. It reads the same `data/haul.json`, so a changed number or app URL is edited once. |

## 1 — copy the feed

```sh
cp web/haul.json  /path/to/brownhub-website/data/haul.json
cp web/haul.html  /path/to/brownhub-website/haul.html
```

`data/haul.json` is served as `application/json` by the existing host. The app asks
for `https://www.brownhub283.com/data/haul.json` first and falls back to reading
`llms.txt` + `css/style.css` if it is not there yet, so the app never depends on
this step to boot.

## 2 — list the service in the site's own navigation

Done in `js/nav.js`: it appends **Luggage** after Contact on every page that has the
header — resolving the path from the site root, so journal posts work too — and adds
it to the Services mega panel. `index.html` and `services.html` carry the link in
their HTML as well, because the service worker serves `nav.js?v=12` cache-first and a
returning visitor would otherwise keep the old nav until the cache rotates. The
injection skips the page when the link is already there.

The same file reads `data/haul.json` with `cache: "no-store"` and, when `haul.app`
is an `http(s)://` URL, rewrites both Luggage links to it. This is why the nav needs
no second release when the app is hosted. The feed fetch is same-origin and allowed
by the page CSP (`connect-src 'self'`); an empty value, a 404 or a non-URL value
leaves `haul.html` in place. A `*.trycloudflare.com` value is refused on purpose:
that hostname dies with the `cloudflared` process that owns it. A durable host or
your own domain passes.

`services.html` also gained a section, `#luggage-service`, in the page's own
`service-row` idiom: what Haul is, four checked points, and a link to `haul.html`.
`sitemap.xml` lists `haul.html`.

## 3 — deploy the app to a real host

The feed currently carries:

```json
"haul": { "app": "" }
```

Set that one value to the host's HTTPS URL. `haul.html` shows its "Open BrownHub
Haul" buttons only when `haul.app` is set, and the site nav opens the same address;
until then both fall back to the page and WhatsApp, which need no host.

**The app cannot live on the studio's GitHub Pages host.** Pages serves static files
only; Haul needs its Node process for `/api/*`, the shared manifest and the dispatch
board, plus a persistent disk for `data/` (manifest, `secret.key`, photos). A phone
also installs a PWA only from an `https://` address. The app repository now carries
the deployment files; pick one:

### A — Render (managed, no server to run)

1. Put this repository on GitHub (private is fine).
2. In Render: **New → Blueprint**, pick the repo. `render.yaml` builds the
   `Dockerfile`, mounts a 1 GB disk at `/data`, and generates `HAUL_TOKEN`.
   Render's free plan has no disks, so the blueprint asks for **Starter** (about
   $7/month); a free service loses every booking on redeploy.
3. Copy the generated `HAUL_TOKEN` from the dashboard and keep it at the desk.
4. When the service is healthy, set `"app": "https://brownhub-haul.onrender.com/#/book"`
   in `data/haul.json` and push.

### B — Fly.io

```sh
fly launch --no-deploy --copy-config --name brownhub-haul --region jnb
fly volumes create haul_data --region jnb --size 1
fly secrets set HAUL_TOKEN='the depot passphrase'
fly deploy
```

`fly.toml` already sets `HOST=0.0.0.0`, `TRUST_PROXY=1`, the volume mount and
`min_machines_running = 1`. The address is `https://brownhub-haul.fly.dev/`; put
`https://brownhub-haul.fly.dev/#/book` in the feed.

### C — VPS with nginx (same domain)

`deploy/haul.service` runs the app as a service; `deploy/nginx-haul.conf` is the
TLS vhost. Point **`haul.brownhub283.com`** (an A record at Porkbun, in place of
the parking records) at the VPS, issue a certificate, and set
`"app": "https://haul.brownhub283.com/#/book"`.

The studio's apex and `www` point at GitHub Pages, so `https://www.brownhub283.com/haul/`
is not available unless the whole site moves to that VPS. A subdomain is the
small change; the app is already relative-URL clean if you do mount it at a path.

### On any host

* Give it a **persistent disk** and keep `DB`, `PHOTOS` and `BRAND_CACHE` under it.
* Set `HAUL_TOKEN`; the server otherwise mints one and prints it once in the logs.
* Set `TRUST_PROXY=1` when the app's peer is not loopback (a platform proxy), so
  the PIN and booking buckets see the real client rather than the proxy.
* HTTPS is mandatory for the service worker and the install prompt.
* Check `/api/health` after boot, then read the `[brand] … source: haul.json` line
  in the logs. `/api/health` shows the full manifest path only to the token holder.

There is no hosting account, SSH server or provider CLI on this Mac, which is why
the link is still empty. The code and manifests are ready; the missing input is a
host login or a VPS address.

## 4 — let the app pick it up

The app reads the feed at boot. Restart it once after the site deploys:

```sh
node server.mjs        # log: [brand] BrownHub · … · accent #c82027 · source: haul.json
```

`source: haul.json` means the structured feed won; `llms.txt + style.css` means the
feed was not reachable and the app read the published pages instead. Either way the
answer is cached in `data/brand.json`, so the depot laptop boots correctly with the
site offline.

## What the app takes from the feed

* `parent` — the name in the header strip and footer, the link back, the document title
* `tokens` — `accent`, `bg`, `surface`, `border`, `text`, `text-muted`, `accent-2`, `radius`,
  mapped onto the app's own CSS variables at serve time
* `studio` — address, phone, e-mail, hours in the footer's studio column
* `haul` — the product name, the depot counter line, the order WhatsApp, collection hours

Changing any of those on the site changes the app on its next boot. Nothing about the
studio is typed into the app's source.
