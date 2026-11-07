import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bindPorts } from "./ports.mjs";
import { session } from "./cdp.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const scratch = await mkdtemp(join(tmpdir(), "haul-media-"));
const port = 8819;
const cdpPort = 9417;
const base = `http://127.0.0.1:${port}`;
let server;
let chrome;
let s;
let checks = 0;
const mediaRequests = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, value, detail) {
  checks++;
  assert.ok(value, `${name}: ${JSON.stringify(detail)}`);
  console.log(`ok ${checks} — ${name}`);
}

async function waitFor(expression, label) {
  for (let i = 0; i < 100; i++) {
    try { if (await s.eval(expression)) return; } catch {}
    await sleep(100);
  }
  throw new Error(`timed out: ${label}`);
}

try {
  await bindPorts([port, cdpPort]);
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DB: join(scratch, "shipments.json"), BROWN_OFFLINE: "1", HAUL_TOKEN: "test-only-depot-token" },
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await sleep(75);
  }

  const sources = await readFile(join(ROOT, "assets", "MEDIA-SOURCES.txt"), "utf8");
  check("media credits name the Pexels License", /Pexels License/.test(sources), sources.slice(0, 120));
  check("media credits record all three source pages", ["36783842", "15556159", "31256899"].every((id) => sources.includes(id)), sources);
  for (const file of ["airport-hero.mp4", "airport-terminal.mp4", "airport-apron.mp4"]) {
    const res = await fetch(`${base}/assets/${file}`, { method: "HEAD" });
    check(`${file} is served as local video`, res.status === 200 && /video\/mp4/.test(res.headers.get("content-type") || ""), [res.status, res.headers.get("content-type")]);
  }
  const rangeRes = await fetch(`${base}/assets/airport-hero.mp4`, { headers: { range: "bytes=0-1023" } });
  const rangeBytes = new Uint8Array(await rangeRes.arrayBuffer());
  check("video supports byte ranges for mobile playback", rangeRes.status === 206 && rangeBytes.length === 1024 && /^bytes 0-1023\//.test(rangeRes.headers.get("content-range") || ""), [rangeRes.status, rangeBytes.length, rangeRes.headers.get("content-range")]);

  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${join(scratch, "chrome")}`,
    "--window-size=1440,900", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
  ], { stdio: "ignore", detached: true });
  s = await session(cdpPort);
  s.conn.on("Network.requestWillBeSent", (p) => {
    if (/\.mp4(?:\?|$)/i.test(p.request.url)) mediaRequests.push(p.request.url);
  });
  await s.setSize(1440, 900);
  await s.navigate(`${base}/#/book`);
  await waitFor(`document.querySelectorAll('[data-airport-video]').length === 3`, "three airport videos");

  check("videos are muted, looping, inline and poster-first", await s.eval(`[...document.querySelectorAll('[data-airport-video]')].every(v => v.muted && v.loop && v.playsInline && v.preload === 'none' && v.getAttribute('poster') && v.width > 0 && v.height > 0)`));
  check("videos keep sources lazy", await s.eval(`[...document.querySelectorAll('[data-airport-video]')].every(v => v.dataset.src && v.dataset.src.startsWith('assets/'))`));
  await waitFor(`document.querySelector('.hero [data-airport-video]').readyState >= 2`, "hero video metadata");
  await waitFor(`!document.querySelector('.hero [data-airport-video]').paused`, "hero autoplay");
  check("airport footage plays slowly", await s.eval(`[...document.querySelectorAll('[data-airport-video]')].filter(v => v.currentSrc).every(v => v.playbackRate === 0.65)`));

  for (const selector of [".airport-card [data-airport-video]", ".fleet-grid [data-airport-video]"]) {
    await s.eval(`document.querySelector('${selector}').scrollIntoView({block:'center'}); true`);
    await waitFor(`document.querySelector('${selector}').readyState >= 2 && !document.querySelector('${selector}').paused`, `${selector} playback`);
  }
  check("each visible video reserves layout", await s.eval(`[...document.querySelectorAll('[data-airport-video]')].every(v => v.getBoundingClientRect().height > 100)`));
  await s.eval(`document.querySelector('#book-form').scrollIntoView({block:'center'}); true`);
  await waitFor(`[...document.querySelectorAll('[data-airport-video]')].every(v => v.paused)`, "offscreen pause");
  check("offscreen videos pause", await s.eval(`[...document.querySelectorAll('[data-airport-video]')].every(v => v.paused)`));
  check("no remote media is requested", mediaRequests.length > 0 && mediaRequests.every((url) => url.startsWith(`${base}/assets/`)), mediaRequests);

  await s.setSize(390, 844, true, 2);
  await s.navigate(`${base}/#/book`);
  await waitFor(`document.querySelectorAll('[data-airport-video]').length === 3`, "mobile videos");
  await s.eval(`document.querySelector('#airports').scrollIntoView(); true`);
  check("mobile media does not overflow", await s.eval(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`));

  await s.eval(`navigator.serviceWorker.getRegistrations().then(rs => Promise.all(rs.map(r => r.unregister()))); true`);
  await sleep(500);
  await s.navigate("about:blank");
  await sleep(200);
  const rmOverride = await s.raw("Page.addScriptToEvaluateOnNewDocument", { source: `const _mm = window.matchMedia.bind(window); window.matchMedia = (q) => { const m = _mm(q); if (/prefers-reduced-motion/.test(q)) { Object.defineProperty(m, 'matches', { get: () => true }); Object.defineProperty(m, 'media', { value: q }); } return m; };` });
  await s.navigate(`${base}/#/book`);
  await waitFor(`document.querySelectorAll('[data-airport-video]').length === 3`, "reduced-motion videos");
  await sleep(700);
  check("reduced motion keeps posters without attaching video", await s.eval(`[...document.querySelectorAll('[data-airport-video]')].every(v => !v.getAttribute('src') && !v.currentSrc && v.getAttribute('poster'))`));
  check("reduced motion disables video perspective", await s.eval(`[...document.querySelectorAll('[data-airport-video]')].every(v => getComputedStyle(v).transform === 'none')`));
  await s.raw("Page.removeScriptToEvaluateOnNewDocument", { identifier: rmOverride.identifier });

  const saveData = await s.raw("Page.addScriptToEvaluateOnNewDocument", { source: `Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } });` });
  await s.navigate(`${base}/#/book`);
  await waitFor(`document.querySelectorAll('[data-airport-video]').length === 3`, "save-data videos");
  check("save-data keeps posters without attaching video", await s.eval(`[...document.querySelectorAll('[data-airport-video]')].every(v => !v.getAttribute('src') && !v.currentSrc && v.getAttribute('poster'))`));
  await s.raw("Page.removeScriptToEvaluateOnNewDocument", { identifier: saveData.identifier });

  const constrained = await s.raw("Page.addScriptToEvaluateOnNewDocument", { source: `Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 2 });` });
  await s.navigate(`${base}/#/book`);
  await waitFor(`document.querySelectorAll('[data-airport-video]').length === 3`, "constrained videos");
  check("constrained devices keep posters without attaching video", await s.eval(`[...document.querySelectorAll('[data-airport-video]')].every(v => !v.getAttribute('src') && !v.currentSrc && v.getAttribute('poster'))`));
  await s.raw("Page.removeScriptToEvaluateOnNewDocument", { identifier: constrained.identifier });

  console.log(`\n${checks} media checks passed`);
} finally {
  s?.conn?.close?.();
  for (const p of [chrome, server]) {
    if (!p?.pid) continue;
    try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} }
  }
  await sleep(250);
  await rm(scratch, { recursive: true, force: true });
}