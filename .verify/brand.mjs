/**
 * Brand-sync harness.
 *
 * Proves that Haul is an app *of* BrownHub Studio and not a standalone brand:
 *   1. the structured feed wins — a stub studio site serves /data/haul.json with a
 *      different accent, and the app wears it (API, served HTML, computed style);
 *   2. without the feed the app reads the published pages (llms.txt + style.css);
 *   3. a dead site falls back to the last cached identity, then to the bundled one;
 *   4. mounted under a reverse-proxy subpath (/haul/) the whole app still works —
 *      assets, relative API calls, booking quote — and its photo URLs resolve
 *      under that subpath, which is what "not hosted on its own domain" costs.
 *
 * Own ports, own throwaway DB, own Chrome profile. Nothing touches data/.
 */
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bindPorts } from "./ports.mjs";
import { session } from "./cdp.mjs";
import { appTokens, FALLBACK } from "../core/brand.mjs";

const ROOT = "/Users/brownhub/Documents/Qoder/2026-10-27/a6740f12";
const APP = 8851;          // the Haul app under test
const SITE = 8850;         // the stub studio site
const PROXY = 8852;        // a /haul/ reverse proxy in front of the app
const CDP = 9412;
const OUT = join(ROOT, ".verify", "shots");
const DB = join(ROOT, ".verify", `brand-${process.pid}.json`);
const PHOTOS = join(ROOT, ".verify", `brand-photos-${process.pid}`);
const CACHE = join(ROOT, ".verify", `brand-${process.pid}-cache.json`);
const PROFILE = join(ROOT, ".verify", "brand-profile");
const TOKEN = `BHDEPOT-BRAND-${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
};

/* ————————————————— the stub studio site ————————————————— */

const FEED = {
  version: 1,
  parent: {
    name: "BrownHub",
    displayName: "BrownHub Studio",
    descriptor: "graphic design and website company in Accra, Ghana",
    site: `http://127.0.0.1:${SITE}/`,
    tagline: "intellectual designs",
    city: "Accra, Ghana",
  },
  attribution: "An app by BrownHub Studio",
  tokens: {
    bg: "#f7fbff", surface: "#ffffff", border: "#d6e2ef", text: "#0b1a24",
    "text-muted": "#4a6274", accent: "#0f766e", "accent-fill-hover": "#0b5f58",
    "accent-2": "#7c4a12", radius: "18px",
  },
  studio: {
    email: "studio@example.test",
    phone: "+233 20 000 0001",
    whatsapp: "233200000001",
    address: "12 Studio Test Street, Accra",
    hours: "Mon–Fri, 9am–6pm GMT",
  },
  haul: {
    brand: "BrownHub Haul",
    tagline: "luggage, handled",
    app: "",
    whatsapp: "233535583460",
    phone: "+233 53 558 3460",
    email: "haul@example.test",
    hours: "Mon–Sat 06:00–21:00",
    depot: { name: "Test Depot", address: "Test Depot Yard, Accra", maps: "https://maps.example.test/depot" },
    counter: { name: "KIA desk", address: "Kotoka International Airport, Level 1", maps: "https://maps.example.test/kia" },
  },
};

/** A minimal stand-in for brownhub283.com. `feed` toggles /data/haul.json. */
function stubSite({ feed = true, accent = "#0f766e" } = {}) {
  const llms = `# BrownHub

## Overview
BrownHub is a graphic design and website company in Accra, Ghana, helping businesses communicate.

## Services
- Logo Design
- Website design and development

## Company details
- Website: http://127.0.0.1:${SITE}/
- Email: scraped@example.test
- Phone (calls): +233 20 000 0002
- WhatsApp: +233 20 000 0003 — https://wa.me/233200000003
- Location: Scraped Street, Accra
- Hours: Mon-Fri, 9am-6pm GMT
`;
  const css = `:root{--bg:#1b0b0c;--accent:#f4545a;--radius:14px}
html[data-theme="light"]{--bg:#f7fbff;--surface:#ffffff;--border:#d6e2ef;--text:#0b1a24;--text-muted:#4a6274;--accent:${accent};--accent-fill-hover:#0b5f58;--accent-2:#7c4a12;--radius:16px}`;
  const home = `<!doctype html><html><head><title>BrownHub</title>
<meta property="og:site_name" content="BrownHub">
<meta name="apple-mobile-web-app-title" content="BrownHub Studio">
<script type="application/ld+json">{"@type":"Organization","name":"BrownHub","alternateName":"BrownHub Studio"}</script>
</head><body>studio</body></html>`;
  return createServer((req, res) => {
    const p = req.url.split("?")[0];
    if (p === "/data/haul.json") {
      if (!feed) return send404(res);
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(FEED));
    }
    if (p === "/llms.txt") return res.writeHead(200, { "content-type": "text/plain" }).end(llms);
    if (p === "/css/style.css") return res.writeHead(200, { "content-type": "text/css" }).end(css);
    if (p === "/" || p === "/index.html") return res.writeHead(200, { "content-type": "text/html" }).end(home);
    send404(res);
  }).listen(SITE, "127.0.0.1");
}
function send404(res) {
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
}

/** A /haul/ reverse proxy — the same shape as the nginx block in web/DEPLOY.md. */
function subpathProxy() {
  return createServer((req, res) => {
    if (!req.url.startsWith("/haul")) return send404(res);
    const path = req.url.slice("/haul".length) || "/";
    const up = request(
      { host: "127.0.0.1", port: APP, path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${APP}` } },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }
    );
    up.on("error", () => { res.writeHead(502).end("app down"); });
    req.pipe(up);
  }).listen(PROXY, "127.0.0.1");
}

/* ————————————————— booting the app ————————————————— */

const procs = [];
async function boot({ site = `http://127.0.0.1:${SITE}/`, offline = false, cache = CACHE } = {}) {
  const env = {
    ...process.env,
    PORT: String(APP), HOST: "127.0.0.1", DB, PHOTOS, HAUL_TOKEN: TOKEN,
    BRAND_CACHE: cache, BROWN_SITE: site,
    ...(offline ? { BROWN_OFFLINE: "1" } : {}),
  };
  const p = spawn(process.execPath, [join(ROOT, "server.mjs")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(p);
  let log = "";
  p.stdout.on("data", (b) => { log += b.toString(); });
  p.stderr.on("data", (b) => { log += b.toString(); });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${APP}/api/health`);
      if (r.ok) return { p, log };
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`app did not boot:\n${log}`);
}
async function stop(p) {
  if (!p?.pid) return;
  try { p.kill("SIGKILL"); } catch {}
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${APP}/api/health`); await sleep(100); } catch { return; }
  }
}
const brand = async () => (await fetch(`http://127.0.0.1:${APP}/api/brand`)).json();
const head = async () => await (await fetch(`http://127.0.0.1:${APP}/`)).text();

/* ————————————————— run ————————————————— */

let site, proxy, chrome;
try {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(PHOTOS, { recursive: true });
  await bindPorts([APP, SITE, PROXY, CDP]);
  rmSync(CACHE, { force: true });

  /* 0 — the palette contract: one Studio-derived ramp, static and injected */
  const cssText = readFileSync(join(ROOT, "styles", "app.css"), "utf8");
  const LEGACY_LITERAL = /#(?:07121f|0b1a2a|102338|111c29|091522|0d1e30|152638|142639|f3c969|d9aa46|eaf5fa|f2f8fb|e8f3f8)|243,201,105|49,89,118/i;
  check("the stylesheet keeps no independent navy/gold literals", !LEGACY_LITERAL.test(cssText), cssText.match(LEGACY_LITERAL)?.[0]);
  const rootBlock = (cssText.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "").replace(/\s+/g, " ");
  const fallbackMissing = Object.entries(appTokens(FALLBACK)).filter(([k, v]) => !rootBlock.includes(`${k}:${v}`));
  check("the static :root fallback is the bundled Studio ramp", fallbackMissing.length === 0, fallbackMissing.map(([k]) => k));
  const fb = appTokens(FALLBACK);
  check("appTokens maps the full night/highlight ramp",
    fb["--night"] === "color-mix(in srgb, #26100f 68%, #000)" && fb["--night-2"] === "color-mix(in srgb, #26100f 82%, #000)" &&
    fb["--night-3"] === "#26100f" && fb["--gold"] === "color-mix(in srgb, #8a5e28 58%, #ffffff)" &&
    fb["--gold-2"] === "#8a5e28" && fb["--ice"] === "color-mix(in srgb, #e9d6c6 55%, #ffffff)",
    [fb["--night"], fb["--gold"], fb["--ice"]]);

  /* 1 — the feed wins */
  site = stubSite({ feed: true });
  let app = await boot();
  let b = await brand();
  check("the feed is the source when it exists", b.source === "haul.json", b.source);
  check("the studio's display name comes from the feed", b.parent.displayName === "BrownHub Studio", b.parent);
  check("the accent comes from the feed", b.tokens.accent === "#0f766e", b.tokens.accent);
  check("the studio address comes from the feed", b.studio.address === "12 Studio Test Street, Accra", b.studio.address);
  check("the haul ops block survives untouched", b.haul.whatsapp === "233535583460" && b.haul.depot.address === "Test Depot Yard, Accra", b.haul);
  const html1 = await head();
  check("the served shell carries the feed's palette", html1.includes("--red:#0f766e") && html1.includes("--paper:#f7fbff"), html1.match(/id="brand-tokens"[^>]*>.{0,120}/)?.[0]);
  check("the shell injects the Studio night ramp",
    html1.includes("--night:color-mix(in srgb, #0b1a24 68%, #000)") && html1.includes("--night-2:color-mix(in srgb, #0b1a24 82%, #000)") && html1.includes("--night-3:#0b1a24"),
    html1.match(/--night[^;}]*/g));
  check("the shell injects the Studio highlight ramp",
    html1.includes("--gold:color-mix(in srgb, #7c4a12 58%, #ffffff)") && html1.includes("--gold-2:#7c4a12") && html1.includes("--ice:color-mix(in srgb, #d6e2ef 55%, #ffffff)"),
    html1.match(/--(?:gold|ice)[^;}]*/g));
  check("the shell has no leftover placeholder", !html1.includes("<!--BRAND-->"), "");
  const html2 = await (await fetch(`http://127.0.0.1:${APP}/index.html`)).text();
  check("/index.html serves the same injected shell", html2.includes("--red:#0f766e") && !html2.includes("<!--BRAND-->"), "");
  check("the identity was cached beside the manifest", JSON.parse(readFileSync(CACHE, "utf8")).brand.tokens.accent === "#0f766e", CACHE);
  const cfg = await (await fetch(`http://127.0.0.1:${APP}/api/config`)).json();
  check("config exposes the studio block the UI paints", cfg.contact.studio.name === "BrownHub Studio" && cfg.contact.studio.site === `http://127.0.0.1:${SITE}/`, cfg.contact.studio);
  check("config keeps the haul order line", cfg.contact.whatsapp === "233535583460" && cfg.contact.brand === "BrownHub Haul", [cfg.contact.brand, cfg.contact.whatsapp]);

  /* 2 — Blink: the identity is actually painted, not just served */
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`, "--window-size=1440,900",
     "--no-first-run", "--hide-scrollbars", "--disable-gpu", "about:blank"], { stdio: "ignore", detached: true });
  const s = await session(CDP, () => {});
  const pageErrors = [];
  s.conn.on("Runtime.exceptionThrown", (p) => pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  s.conn.on("Log.entryAdded", (p) => { if (p.entry.level === "error") pageErrors.push(p.entry.text); });
  await s.setSize(1440, 900, true);
  await s.navigate(`http://127.0.0.1:${APP}/?brand=1#/book`);
  for (let i = 0; i < 60; i++) {
    if (await s.eval(`document.querySelectorAll('#services .svc').length === 3`)) break;
    await sleep(150);
  }
  const pageState = await s.eval(`(() => ({
    url: location.href, title: document.title, route: location.hash,
    services: document.querySelectorAll('#services .svc').length,
    main: (document.querySelector('main') || document.body).innerHTML.length,
    offline: !!document.querySelector('#offline') && !document.querySelector('#offline').hidden,
    text: (document.body.innerText || '').slice(0, 120),
  }))()`);
  if (pageState.services !== 3) throw new Error(`book route did not render: ${JSON.stringify(pageState)}\n${pageErrors.join("\n")}`);
  const look = await s.eval(`(() => {
    const root = getComputedStyle(document.documentElement);
    const svc = document.querySelector('#services .svc');
    const btn = document.querySelector('#submit-btn');
    const css = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : ''; };
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    const mix = (expr) => { probe.style.color = expr; return getComputedStyle(probe).color; };
    const nightMix = mix('color-mix(in srgb, #0b1a24 68%, #000)');
    const night2Mix = mix('color-mix(in srgb, #0b1a24 82%, #000)');
    const goldMix = mix('color-mix(in srgb, #7c4a12 58%, #ffffff)');
    const gold2Mix = mix('#7c4a12');
    const iceMix = mix('color-mix(in srgb, #d6e2ef 55%, #ffffff)');
    const bookStopOld = [mix('color-mix(in srgb, #f7fbff 78%, #eaf5fa)'), mix('color-mix(in srgb, #ffffff 90%, #f2f8fb)')];
    const bookStopNew = mix('color-mix(in srgb, #f7fbff 78%, color-mix(in srgb, #d6e2ef 55%, #ffffff))');
    probe.remove();
    const lum = (cssColor) => { const m = cssColor.match(/[\\d.]+/g); if (!m) return 0;
      const scale = cssColor.startsWith('color(srgb') ? 1 : 1 / 255;
      const c = m.slice(0, 3).map(Number).map((v) => { v *= scale; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
      return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
    const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const bodyColor = getComputedStyle(document.body).color;
    return {
      accent: root.getPropertyValue('--red').trim(),
      paper: root.getPropertyValue('--paper').trim(),
      radius: root.getPropertyValue('--r').trim(),
      night: root.getPropertyValue('--night').trim(),
      night2: root.getPropertyValue('--night-2').trim(),
      night3: root.getPropertyValue('--night-3').trim(),
      gold: root.getPropertyValue('--gold').trim(),
      gold2: root.getPropertyValue('--gold-2').trim(),
      ice: root.getPropertyValue('--ice').trim(),
      nightMix, night2Mix, goldMix, gold2Mix, iceMix, bookStopOld, bookStopNew,
      attr: document.querySelector('#studio-attribution')?.textContent,
      host: document.querySelector('#studio-host')?.textContent,
      site: document.querySelector('#studio-link')?.getAttribute('href'),
      footStudio: document.querySelector('#foot-studio')?.textContent.replace(/\\s+/g, ' ').trim(),
      footAttr: document.querySelector('#foot-attribution')?.textContent,
      copy: document.querySelector('#copy-parent')?.textContent,
      title: document.title,
      btnBg: btn ? getComputedStyle(btn).backgroundImage : '',
      svcRadius: getComputedStyle(document.querySelector('#services .svc')).borderRadius,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      bodyBg, bodyColor,
      bodyContrast: contrast(bodyColor, bodyBg),
      signupContrast: contrast(css('.nav-signup', 'color'), css('.nav-signup', 'backgroundColor')),
      bookContrast: contrast(css('#book-h', 'color'), css('.booking-section', 'backgroundColor')),
      heroBg: css('.hero', 'backgroundColor'),
      heroLightBg: css('.hero-light', 'backgroundImage'),
      navBg: css('.topbar-in', 'backgroundImage'),
      parentBg: css('.parentbar', 'backgroundColor'),
      glassBg: css('.hero-proof', 'backgroundImage'),
      quickBg: css('.quick-book', 'backgroundImage'),
      marqueeBg: css('.route-marquee', 'backgroundColor'),
      airportsBg: css('.airports', 'backgroundImage'),
      arrivalBg: css('.arrival', 'backgroundImage'),
      fleetBg: css('.fleet-feature', 'backgroundColor'),
      faqBg: css('.faq', 'backgroundImage'),
      numbersBg: css('.numbers', 'backgroundImage'),
      footBg: css('.foot', 'backgroundColor'),
      modalBg: css('.account-modal', 'backgroundColor'),
      toastBg: css('.toast', 'backgroundColor'),
      bookingBg: css('.booking-section', 'backgroundImage'),
      heroCtaBg: css('.hero .btn.primary', 'backgroundImage'),
      heroCtaColor: css('.hero .btn.primary', 'color'),
    };
  })()`);
  check("WebKit-grade computed style: the accent is the feed's", look.accent === "#0f766e", look.accent);
  check("the paper colour is the feed's", look.paper === "#f7fbff", look.paper);
  check("the studio radius token and compact service-card radius reach the components", look.svcRadius === "10px" && look.radius === "18px", [look.radius, look.svcRadius]);
  check("the booking action is painted in the feed accent", /15,\s*118,\s*110/.test(look.btnBg), look.btnBg.slice(0, 90));
  /* Task 2 — the whole visible UI inherits the Studio palette */
  check("the night ramp is the Studio text mix",
    (look.night === "color-mix(in srgb, #0b1a24 68%, #000)" || look.night === look.nightMix) &&
    (look.night2 === "color-mix(in srgb, #0b1a24 82%, #000)" || look.night2 === look.night2Mix) &&
    (look.night3 === "#0b1a24" || look.night3 === "rgb(11, 26, 36)"),
    [look.night, look.night2, look.night3]);
  check("the body wears the Studio night, not the old navy", look.bodyBg === look.nightMix && look.bodyBg !== "rgb(7, 18, 31)", [look.bodyBg, look.nightMix]);
  check("the highlight ramp derives from Studio bronze", look.gold.includes("color-mix") && look.gold.includes("#7c4a12") && (look.gold2 === "#7c4a12" || look.gold2 === look.gold2Mix), [look.gold, look.gold2]);
  check("the ice tint derives from the Studio border", look.ice.includes("color-mix") && look.ice.includes("#d6e2ef"), look.ice);
  const OLD_NAVY = /7,\s*18,\s*31|11,\s*26,\s*42|16,\s*35,\s*56|17,\s*28,\s*41|9,\s*21,\s*34|13,\s*30,\s*48|21,\s*38,\s*56|20,\s*38,\s*57|20,\s*39,\s*57|8,\s*20,\s*34|5,\s*15,\s*26|4,\s*13,\s*23|27,\s*48,\s*68|8,\s*22,\s*37|26,\s*46,\s*64|12,\s*28,\s*43|49,\s*89,\s*118|51,\s*86,\s*112|8,\s*21,\s*34|16,\s*36,\s*56|10,\s*24,\s*40|2,\s*10,\s*18|20,\s*40,\s*58|243,\s*201,\s*105|217,\s*170,\s*70/i;
  check("hero and navigation contain no independent navy", !OLD_NAVY.test(`${look.heroBg} ${look.heroLightBg} ${look.navBg} ${look.parentBg}`), [look.heroBg, look.heroLightBg, look.navBg, look.parentBg]);
  const darkRamp = [look.glassBg, look.quickBg, look.marqueeBg, look.airportsBg, look.arrivalBg, look.fleetBg, look.faqBg, look.numbersBg, look.footBg, look.modalBg, look.toastBg].join(" ");
  check("every dark surface wears the Studio night ramp", !OLD_NAVY.test(darkRamp), darkRamp.match(OLD_NAVY)?.[0]);
  const OLD_ICE = /eaf5fa|f2f8fb|e8f3f8|234,\s*245,\s*250|242,\s*248,\s*251|232,\s*243,\s*248/i;
  check("the booking glass gradient mixes Studio ice, not fixed blue",
    !OLD_ICE.test(look.bookingBg) && !look.bookStopOld.some((c) => look.bookingBg.includes(c)) &&
    (look.bookingBg.includes(look.bookStopNew) || look.bookingBg.includes(look.iceMix)),
    look.bookingBg.slice(0, 200));
  check("the hero CTA is the Studio bronze ramp with night text", look.heroCtaBg.includes(look.goldMix) && look.heroCtaBg.includes(look.gold2Mix) && look.heroCtaColor === look.nightMix, [look.heroCtaBg, look.heroCtaColor]);
  check("body text stays readable on the Studio night", look.bodyContrast >= 7, look.bodyContrast);
  check("the sign-up action stays readable", look.signupContrast >= 4.5, look.signupContrast);
  check("booking headings stay readable on the paper", look.bookContrast >= 4.5, look.bookContrast);
  check("the strip names the studio and links back", look.attr === "An app by BrownHub Studio" && look.site === `http://127.0.0.1:${SITE}/`, [look.attr, look.site]);
  check("the strip shows the site host", look.host === `127.0.0.1:${SITE}`, look.host);
  check("the footer lists the studio's address", /12 Studio Test Street/.test(look.footStudio), look.footStudio);
  check("the footer names the studio", look.footAttr === "An app by BrownHub Studio" && look.copy === "BrownHub Studio", [look.footAttr, look.copy]);
  check("the document title says whose app it is", /An app by BrownHub Studio/.test(look.title), look.title);
  check("1440px has no overflow with the strip", look.scrollW <= look.clientW + 1, [look.scrollW, look.clientW]);
  await s.shot(join(OUT, "brand-1440.png"));

  await s.setSize(390, 844, true, 2);
  await s.navigate(`http://127.0.0.1:${APP}/?brand=2#/book`);
  for (let i = 0; i < 60; i++) {
    if (await s.eval(`document.querySelectorAll('#services .svc').length === 3`)) break;
    await sleep(150);
  }
  const phone = await s.eval(`(() => { const bar = document.querySelector('.parentbar'); const r = bar.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), scrollW: document.documentElement.scrollWidth,
             clientW: document.documentElement.clientWidth, hostHidden: getComputedStyle(document.querySelector('#studio-host')).display,
             bodyBg: getComputedStyle(document.body).backgroundColor }; })()`);
  check("390px: the strip fits the screen", phone.w === 390 && phone.scrollW <= phone.clientW + 1, phone);
  check("390px: the domain hides, the attribution stays", phone.hostHidden === "none", phone.hostHidden);
  check("390px: the Studio night paints on mobile, no overflow", phone.bodyBg === look.nightMix && phone.scrollW <= phone.clientW + 1, [phone.bodyBg, phone.scrollW, phone.clientW]);
  await s.shot(join(OUT, "brand-390.png"));
  await sleep(250);

  /* 3 — under /haul/: assets, API, booking and photo URLs all mount-relative */
  proxy = subpathProxy();
  const seeded = await fetch(`http://127.0.0.1:${APP}/api/shipments/BH-D3MO24/photos`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-haul-token": TOKEN },
    body: JSON.stringify({ data: `data:image/png;base64,${readFileSync(join(ROOT, "assets", "logo.png")).toString("base64")}` }),
  });
  check("a photo is seeded for the subpath test", seeded.status === 201, seeded.status);

  await s.setSize(390, 844, true, 2);
  await s.navigate(`http://127.0.0.1:${PROXY}/haul/?mount=1#/book`);
  let mounted = null;
  for (let i = 0; i < 80; i++) {
    mounted = await s.eval(`(() => ({
      tiers: document.querySelectorAll('#services .svc').length,
      total: (document.querySelector('#t-total') || {}).textContent || '',
      apiFailed: !!document.querySelector('#offline') && !document.querySelector('#offline').hidden,
    }))()`);
    if (mounted.tiers === 3 && /₵/.test(mounted.total)) break;
    await sleep(200);
  }
  check("mounted at /haul/: the styles and modules load", mounted.tiers === 3, mounted);
  check("mounted at /haul/: the relative API call returns a live quote", /₵/.test(mounted.total) && !mounted.apiFailed, mounted);
  await s.shot(join(OUT, "brand-subpath-book.png"));

  await s.navigate(`http://127.0.0.1:${PROXY}/haul/?mount=2#/track/BH-D3MO24`);
  let shot = null;
  for (let i = 0; i < 80; i++) {
    shot = await s.eval(`(() => { const i = document.querySelector('.gallery .shot img');
      return i ? { src: i.getAttribute('src'), abs: i.src, w: i.naturalWidth, card: !!document.querySelector('.track-card') } : null; })()`);
    if (shot && shot.w > 0) break;
    await sleep(200);
  }
  check("mounted at /haul/: the tracker renders", !!shot?.card, shot);
  check("mounted at /haul/: the custody photo resolves under the subpath",
    !!shot && shot.abs.includes("/haul/photos/BH-") && shot.w > 0, shot);

  await stop(app.p);

  /* 4 — no feed: the published pages are enough */
  await new Promise((r) => site.close(r));
  site = stubSite({ feed: false, accent: "#1d4ed8" });
  app = await boot({ cache: CACHE + ".scrape" });
  b = await brand();
  check("without the feed the app reads llms.txt + the stylesheet", b.source === "llms.txt + style.css", b.source);
  check("the accent is scraped from the live stylesheet", b.tokens.accent === "#1d4ed8", b.tokens.accent);
  check("the address is scraped from llms.txt", b.studio.address === "Scraped Street, Accra", b.studio.address);
  check("the WhatsApp number is scraped, not guessed", b.studio.whatsapp === "233200000003", b.studio.whatsapp);
  check("the studio's full name is read from the homepage", b.parent.displayName === "BrownHub Studio", b.parent.displayName);
  await stop(app.p);

  /* 5 — dead site, cache present → the last good identity */
  await new Promise((r) => site.close(r));
  app = await boot({ site: "http://127.0.0.1:1/", cache: CACHE });
  b = await brand();
  check("a dead site falls back to the cache", /cached/.test(b.source) && b.tokens.accent === "#0f766e", b.source);
  check("the cached studio block is still complete", b.studio.address === "12 Studio Test Street, Accra" && b.parent.displayName === "BrownHub Studio", b.studio);
  await stop(app.p);

  /* 6 — dead site, no cache → the bundled last-known values, and it still boots */
  app = await boot({ site: "http://127.0.0.1:1/", cache: CACHE + ".never" });
  b = await brand();
  const health = await (await fetch(`http://127.0.0.1:${APP}/api/health`)).json();
  check("a first boot with no site still answers", health.ok === true, health);
  check("it says it is on bundled values", b.source === "bundled fallback", b.source);
  check("the bundled accent is the studio's red", b.tokens.accent === "#c82027", b.tokens.accent);
  check("the bundled address is the studio's", /Accra New Town/.test(b.studio.address), b.studio.address);
  await stop(app.p);

  /* 7 — offline flag, cache present → cached, no network attempt */
  app = await boot({ offline: true, cache: CACHE + ".scrape" });
  b = await brand();
  check("offline mode uses the cache and says so", /offline mode/.test(b.source) && b.tokens.accent === "#1d4ed8", b.source);
  await stop(app.p);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} brand-sync assertions passed`);
  writeFileSync(join(ROOT, ".verify", "brand-results.json"), JSON.stringify({ passed: results.length - failed.length, total: results.length, results }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error("harness failed:", e);
  process.exitCode = 1;
} finally {
  try { site?.close(); } catch {}
  try { proxy?.close(); } catch {}
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
  if (chrome?.pid) {
    try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
    try { chrome.kill("SIGKILL"); } catch {}
  }
  await sleep(600);
  for (const f of [DB, CACHE, CACHE + ".scrape", CACHE + ".never"]) rmSync(f, { force: true });
  rmSync(join(ROOT, ".verify", `brand-${process.pid}-cache.json.scrape`), { force: true });
  rmSync(PHOTOS, { recursive: true, force: true });
  rmSync(PROFILE, { recursive: true, force: true });
  try { await bindPorts([APP, SITE, PROXY, CDP]); console.log("teardown clean · ports free"); }
  catch (e) { console.log("!! " + e.message); }
}
