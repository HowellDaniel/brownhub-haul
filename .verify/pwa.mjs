/**
 * Installability harness — the app as a phone installs it.
 *
 * Installability is a browser verdict, not a CSS claim, so this asks the engine:
 *   Page.getAppManifest       — the manifest parsed, with which URLs it resolved to
 *   Page.getInstallabilityErrors — Chrome's own list of reasons "Install" is absent
 * plus the things an engine cannot judge for us:
 *
 *   • the shell worker registers, takes control, and its cache holds the app but
 *     never an /api/ response or a custody photo;
 *   • an offline reload still paints the booking shell (a traveller in a basement
 *     car park gets the form, not the browser's dinosaur);
 *   • the install button is wired to the prompt event, and an iPhone gets the
 *     Add-to-Home-Screen recipe from WebKit instead (see .verify/webkit.mjs);
 *   • the same works mounted at /haul/ through a reverse proxy, because that is
 *     how web/DEPLOY.md says to publish it.
 *
 * Own ports, own throwaway DB, own Chrome profile. Nothing touches data/.
 */
import { createServer, request } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bindPorts } from "./ports.mjs";
import { session } from "./cdp.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APP = 8854;
const PROXY = 8855;
const CDP = 9414;
const CDP_APP = 9415;
const OUT = join(ROOT, ".verify", "shots");
const DB = join(ROOT, ".verify", `pwa-${process.pid}.json`);
const PHOTOS = join(ROOT, ".verify", `pwa-photos-${process.pid}`);
const CACHE = join(ROOT, ".verify", `pwa-${process.pid}-brand.json`);
const PROFILE = join(ROOT, ".verify", "pwa-profile");
const PROFILE_APP = join(ROOT, ".verify", "pwa-app-profile");
const TOKEN = `BHDEPOT-PWA-${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
};

const pngSize = (path) => {
  const b = readFileSync(path);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

/** The same /haul/ reverse proxy shape as the nginx block in web/DEPLOY.md. */
function proxy() {
  return createServer((req, res) => {
    if (!req.url.startsWith("/haul")) return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    const path = req.url.slice("/haul".length) || "/";
    const up = request(
      { host: "127.0.0.1", port: APP, path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${APP}` } },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }
    );
    up.on("error", () => res.writeHead(502).end("app down"));
    req.pipe(up);
  }).listen(PROXY, "127.0.0.1");
}

let chrome, chromeApp, up, site;
try {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(PHOTOS, { recursive: true });
  await bindPorts([APP, PROXY, CDP, CDP_APP]);
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(PROFILE_APP, { recursive: true, force: true });

  up = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP), HOST: "127.0.0.1", DB, PHOTOS, HAUL_TOKEN: TOKEN, BRAND_CACHE: CACHE, BROWN_OFFLINE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  up.stdout.resume(); up.stderr.resume();
  let healthy = false;
  for (let i = 0; i < 80 && !healthy; i++) {
    await sleep(100);
    try { healthy = (await fetch(`http://127.0.0.1:${APP}/api/health`)).ok; } catch { /* booting */ }
  }
  if (!healthy) throw new Error("app never came up");
  site = proxy();

  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`, "--window-size=1440,900",
     "--no-first-run", "--hide-scrollbars", "--disable-gpu", "about:blank"], { stdio: "ignore", detached: true });
  const s = await session(CDP, () => {});
  const pageErrors = [];
  s.conn.on("Runtime.exceptionThrown", (p) => pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  s.conn.on("Log.entryAdded", (p) => { if (p.entry.level === "error") pageErrors.push(p.entry.text); });
  await s.setSize(1440, 900, false, 2);

  /* ——— 1. the manifest, as the engine parsed it ——— */
  const manRes = await fetch(`http://127.0.0.1:${APP}/site.webmanifest`);
  const man = await manRes.json().catch(() => null);
  check("the manifest is served as application/manifest+json",
    manRes.ok && /application\/manifest\+json/.test(manRes.headers.get("content-type") || ""), manRes.headers.get("content-type"));
  check("it names the product and says standalone", man?.name === "BrownHub Haul — luggage, handled" && man?.display === "standalone", man?.name);
  check("it starts in the booking view", man?.start_url === "./#/book" && man?.scope === "./", [man?.start_url, man?.scope]);
  check("it ships 192, 512 and a maskable 512", man?.icons?.length === 3 && man.icons.some((i) => i.purpose === "maskable"), man?.icons);
  check("it carries three shortcuts", man?.shortcuts?.length === 3, man?.shortcuts?.map((x) => x.url));

  await s.navigate(`http://127.0.0.1:${APP}/?pwa=1#/book`);
  await sleep(2200);
  const parsed = await s.raw("Page.getAppManifest");
  const errors = await s.raw("Page.getInstallabilityErrors");
  check("the browser parses the manifest with no errors", (parsed.errors || []).length === 0, parsed.errors);
  check("the browser reports no reason install is unavailable", (errors.installabilityErrors || []).length === 0, errors.installabilityErrors);
  check("its start URL and scope resolve against the app root",
    parsed.manifest?.startUrl === `http://127.0.0.1:${APP}/#/book` && parsed.manifest?.scope === `http://127.0.0.1:${APP}/`,
    [parsed.manifest?.startUrl, parsed.manifest?.scope]);
  check("the theme colour is the studio's accent, not the old fallback",
    parsed.manifest?.themeColor === "rgba(200,32,39,1)", parsed.manifest?.themeColor);

  /* ——— 2. the icons are real files at the sizes they claim ——— */
  const icons = [
    ["assets/icons/icon-192.png", 192],
    ["assets/icons/icon-512.png", 512],
    ["assets/icons/icon-maskable-512.png", 512],
    ["assets/icons/apple-touch-icon.png", 180],
  ];
  for (const [path, size] of icons) {
    const r = await fetch(`http://127.0.0.1:${APP}/${path}`);
    const dims = r.ok ? pngSize(join(ROOT, path)) : null;
    check(`${path.split("/").pop()} is a real ${size}×${size} PNG`, r.ok && dims?.w === size && dims?.h === size, [r.status, dims]);
  }

  /* ——— 3. the worker holds the shell, and only the shell ——— */
  /* The cache name carries the shell version; read it off the worker rather
     than pinning a version here, so a shell bump cannot quietly empty this
     check. */
  const sw = await s.eval(`navigator.serviceWorker.getRegistration().then(async (r) => {
    const keys = r ? await caches.keys() : [];
    const shell = keys.find((k) => k.startsWith('brownhub-haul-'));
    let urls = [];
    if (r && r.active && shell) { const c = await caches.open(shell); urls = (await c.keys()).map(k => new URL(k.url).pathname); }
    return { scope: r && r.scope, state: r && r.active && r.active.state, controller: !!navigator.serviceWorker.controller,
             secure: isSecureContext, keys, shell, urls };
  })`, { awaitPromise: true });
  check("localhost is a secure context, so the worker may register", sw.secure === true, sw.secure);
  check("the shell worker activates at the app scope", sw.state === "activated" && sw.scope === `http://127.0.0.1:${APP}/`, sw);
  check("it controls the page without a reload", sw.controller === true, sw.controller);
  check("the shell is in the cache", sw.urls.length >= 19, sw.urls);
  check("no API response or custody photo is cached",
    !sw.urls.some((u) => u.startsWith("/api/") || u.startsWith("/photos/")), sw.urls);
  check("the cached shell includes the install sheet and the worker itself is not self-cached",
    sw.urls.includes("/") && sw.urls.includes("/app/js/install.mjs") && !sw.urls.includes("/sw.js"), sw.urls);

  /* ——— 4. iOS head tags are in the same shell ——— */
  const head = await s.eval(`(() => {
    const meta = (n) => { const m = document.querySelector('meta[name="' + n + '"]'); return m && m.content; };
    return {
      capable: meta('apple-mobile-web-app-capable'), mobile: meta('mobile-web-app-capable'),
      title: meta('apple-mobile-web-app-title'), theme: meta('theme-color'),
      icon: (document.querySelector('link[rel="apple-touch-icon"]') || {}).getAttribute('href'),
      manifest: (document.querySelector('link[rel="manifest"]') || {}).getAttribute('href'),
    };
  })()`);
  check("Safari's own head tags ship with the shell",
    head.capable === "yes" && head.mobile === "yes" && head.title === "BrownHub Haul" && head.icon === "assets/icons/apple-touch-icon.png",
    head);
  check("the status-bar and theme colour match the Studio dark palette", head.theme === "#1b0b0c", head.theme);

  /* ——— 4b. an installed iPhone's status bar and home indicator ———
     black-translucent lets the page run under the clock and the home
     indicator. Simulate the insets iOS would report and prove the fixed
     chrome moves instead of hiding under them. */
  const safe = await s.eval(`(() => {
    const root = document.documentElement;
    const probe = document.createElement('div');
    probe.className = 'toast';
    document.body.append(probe);
    root.style.setProperty('--safe-top', '47px');
    root.style.setProperty('--safe-bottom', '34px');
    const top = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).top);
    const out = {
      studioBar: top('.parentbar'),
      nav: top('.topbar'),
      toastBottom: parseFloat(getComputedStyle(probe).bottom),
      modalPadTop: parseFloat(getComputedStyle(document.querySelector('.modal')).paddingTop),
      modalPadBottom: parseFloat(getComputedStyle(document.querySelector('.modal')).paddingBottom),
    };
    root.style.removeProperty('--safe-top');
    root.style.removeProperty('--safe-bottom');
    probe.remove();
    return out;
  })()`);
  check("the installed status bar pushes the Studio bar and the nav below it",
    Math.round(safe.studioBar) === 47 && Math.round(safe.nav) === 79, safe);
  check("the home indicator lifts the toast and pads the sheet",
    Math.round(safe.toastBottom) === 56 && safe.modalPadTop >= 47 && safe.modalPadBottom >= 34, safe);

  /* ——— 5. the install button is wired, and a dismissal keeps it ——— */
  const wired = await s.eval(`(async () => {
    const btn = document.getElementById('install-app');
    let called = false;
    const e = new Event('beforeinstallprompt');
    e.prompt = () => { called = true; };
    e.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(e);
    const shown = !btn.hidden;
    btn.click();
    await new Promise(r => setTimeout(r, 120));
    return { shown, called, stillShown: !btn.hidden, aria: btn.getAttribute('aria-expanded') };
  })()`, { awaitPromise: true });
  check("the install button appears when the browser offers a prompt and replays it", wired.shown === true && wired.called === true, wired);
  check("a dismissed install leaves the button available", wired.stillShown === true, wired);

  // The prompt is spent (dismissed above), so a second tap must fall back to the
  // written recipe rather than doing nothing.
  const fallback = await s.eval(`(async () => {
    document.getElementById('install-app').click();
    await new Promise(r => setTimeout(r, 150));
    const s = document.getElementById('install-sheet');
    const out = { sheetOpen: !!(s && !s.hidden),
      steps: [].map.call(document.querySelectorAll('#install-steps li'), (li) => li.textContent),
      lead: (document.getElementById('install-lead') || {}).textContent || '' };
    document.getElementById('install-close').click();
    out.closed = !!(s && s.hidden);
    return out;
  })()`, { awaitPromise: true });
  check("with the prompt spent, the button teaches the browser menu instead of doing nothing",
    fallback.sheetOpen === true && fallback.steps.length === 3 && /menu/i.test(fallback.steps[0]), fallback);
  check("the fallback sheet closes cleanly", fallback.closed === true, fallback);

  /* An Android phone should see the control before Chrome's engagement
     heuristic fires beforeinstallprompt; the tap opens the written recipe
     until the native prompt is available. */
  const desktopUA = await s.eval("navigator.userAgent");
  await s.raw("Emulation.setUserAgentOverride", {
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  });
  await s.navigate(`http://127.0.0.1:${APP}/?pwa=android#/book`);
  await sleep(1500);
  const android = await s.eval(`({
    android: /Android/i.test(navigator.userAgent),
    hidden: document.getElementById('install-app').hidden,
  })`);
  check("an Android phone sees the install control before the native prompt arrives",
    android.android === true && android.hidden === false, android);
  await s.raw("Emulation.setUserAgentOverride", { userAgent: desktopUA });

  /* ——— 6. a phone-width page with the button in the bar ——— */
  await s.setSize(390, 844, true, 2);
  await s.navigate(`http://127.0.0.1:${APP}/?pwa=2#/book`);
  await sleep(1800);
  const narrow = await s.eval(`(() => ({
    scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
    btn: !!document.getElementById('install-app'),
    labelDisplay: getComputedStyle(document.querySelector('#install-app span')).display,
    labelWidth: getComputedStyle(document.querySelector('#install-app span')).width,
    labelClip: getComputedStyle(document.querySelector('#install-app span')).clipPath,
    sheetHidden: document.getElementById('install-sheet').hidden,
  }))()`);
  check("the install pill fits a 390px iPhone", narrow.scrollW <= narrow.clientW + 1 && narrow.btn, narrow);
  check("the install label stays available to assistive technology without taking visual space", narrow.labelWidth === "1px" && narrow.labelClip === "inset(50%)", narrow);
  await s.shot(join(OUT, "pwa-390.png"));

  /* ——— 7. standalone hides the invitation to install ———
     Chrome's emulated media cannot fake display-mode, so launch the app window
     (--app=) for real: that is the mode an installed PWA runs in. */
  chromeApp = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", `--remote-debugging-port=${CDP_APP}`, `--user-data-dir=${PROFILE_APP}`,
     "--app=" + `http://127.0.0.1:${APP}/?pwa=standalone#/book`,
     "--no-first-run", "--hide-scrollbars", "--disable-gpu"], { stdio: "ignore", detached: true });
  const s2 = await session(CDP_APP, () => {});
  await sleep(2000);
  const standalone = await s2.eval(`({
    mode: matchMedia('(display-mode: standalone)').matches,
    browser: matchMedia('(display-mode: browser)').matches,
    exists: !!document.getElementById('install-app'),
    hidden: document.getElementById('install-app')?.hidden,
    brand: !!document.querySelector('.brand'),
  })`);
  check("an installed app runs in standalone and does not ask to be installed again",
    standalone.mode === true && standalone.browser === false && standalone.exists === true && standalone.hidden === true, standalone);
  try { process.kill(-chromeApp.pid, "SIGKILL"); } catch {}
  chromeApp = null;
  await s.setSize(1440, 900, false, 2);

  /* ——— 8. offline: the shell survives, the engine truthfully does not ——— */
  await s.navigate(`http://127.0.0.1:${APP}/?pwa=4#/book`);
  await sleep(1200);
  await s.raw("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await s.navigate(`http://127.0.0.1:${APP}/?pwa=offline#/track`);
  await sleep(1600);
  const offline = await s.eval(`(() => ({
    brand: !!document.querySelector('.brand'),
    tabs: document.querySelectorAll('#tabs a').length,
    banner: !!document.querySelector('#offline') && !document.querySelector('#offline').hidden,
    install: !!document.getElementById('install-app'),
    title: document.title,
  }))()`);
  check("an offline reload still paints the Haul shell", offline.brand === true && offline.tabs === 4 && offline.install === true, offline);
  check("it says the engine is unreachable instead of pretending to book", offline.banner === true, offline.banner);
  await s.shot(join(OUT, "pwa-offline.png"));
  await s.raw("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  /* ——— 9. the same app behind /haul/ ——— */
  await s.eval(`(async () => {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
    return true;
  })()`, { awaitPromise: true });
  await s.navigate(`http://127.0.0.1:${PROXY}/haul/?pwa=sub#/book`);
  await sleep(2400);
  const sub = await s.raw("Page.getAppManifest");
  const subErrors = await s.raw("Page.getInstallabilityErrors");
  const subSw = await s.eval(`navigator.serviceWorker.getRegistration().then(r => ({
    scope: r && r.scope, state: r && r.active && r.active.state, controller: !!navigator.serviceWorker.controller,
    href: (document.querySelector('link[rel=manifest]') || {}).href,
  }))`, { awaitPromise: true });
  check("mounted under /haul/ the manifest still resolves under the prefix",
    sub.manifest?.startUrl === `http://127.0.0.1:${PROXY}/haul/#/book` && sub.manifest?.scope === `http://127.0.0.1:${PROXY}/haul/`,
    [sub.manifest?.startUrl, sub.manifest?.scope]);
  check("the browser still calls the subpath build installable", (subErrors.installabilityErrors || []).length === 0 && (sub.errors || []).length === 0, subErrors);
  check("the worker takes the /haul/ scope, not the domain root",
    subSw.state === "activated" && subSw.scope === `http://127.0.0.1:${PROXY}/haul/` && subSw.controller === true, subSw);
  check("the app loaded from the subpath with its server config", await s.eval("!!window.__HAUL && !!document.querySelector('#services .svc')"), "");
  await s.raw("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await s.navigate(`http://127.0.0.1:${PROXY}/haul/?pwa=suboff#/track`);
  await sleep(1600);
  const subOffline = await s.eval(`({ brand: !!document.querySelector('.brand'), banner: !!document.querySelector('#offline') && !document.querySelector('#offline').hidden })`);
  check("the subpath shell survives offline too", subOffline.brand === true && subOffline.banner === true, subOffline);
  await s.raw("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await s.shot(join(OUT, "pwa-subpath.png"));

  check("no uncaught page errors during the run", pageErrors.filter((e) => !/favicon|ERR_INTERNET_DISCONNECTED|Failed to fetch|net::ERR/i.test(e)).length === 0, pageErrors);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} installability assertions passed`);
  console.log(`shots: ${OUT}`);
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error("harness failed:", e);
  process.exitCode = 1;
} finally {
  try { site?.close(); } catch {}
  try { up?.kill("SIGKILL"); } catch {}
  if (chrome?.pid) {
    try { process.kill(-chrome.pid, "SIGKILL"); } catch {}
    try { chrome.kill("SIGKILL"); } catch {}
  }
  if (chromeApp?.pid) {
    try { process.kill(-chromeApp.pid, "SIGKILL"); } catch {}
    try { chromeApp.kill("SIGKILL"); } catch {}
  }
  await sleep(500);
  for (const f of [DB, CACHE]) rmSync(f, { force: true });
  rmSync(PHOTOS, { recursive: true, force: true });
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(PROFILE_APP, { recursive: true, force: true });
  try { await bindPorts([APP, PROXY, CDP, CDP_APP]); console.log("teardown clean · ports free"); }
  catch (e) { console.log("!! " + e.message); }
}
