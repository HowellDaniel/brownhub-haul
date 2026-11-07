import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { session } from "./cdp.mjs";

const scratch = await mkdtemp(join(tmpdir(), "haul-live-"));
const cdpPort = 9429;
const base = "https://brownhub-haul.onrender.com";
let chrome;
let s;
let checks = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, value, detail) {
  checks++;
  assert.ok(value, `${name}: ${JSON.stringify(detail)}`);
  console.log(`ok ${checks} — ${name}`);
}
async function waitFor(expression, label, tries = 150) {
  for (let i = 0; i < tries; i++) {
    try { if (await s.eval(expression)) return; } catch {}
    await sleep(100);
  }
  throw new Error(`timed out: ${label}`);
}

try {
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${join(scratch, "chrome")}`,
    "--window-size=1280,900", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
  ], { stdio: "ignore", detached: true });
  s = await session(cdpPort);
  await s.setSize(1280, 900);

  await s.navigate(`${base}/`);
  await waitFor(`document.querySelectorAll('[data-airport-video]').length === 3`, "landing videos");

  const palette = await s.eval(`(() => {
    const cs = getComputedStyle(document.documentElement);
    return { bg: cs.getPropertyValue('--paper').trim(), ink: cs.getPropertyValue('--ink').trim(),
             red: cs.getPropertyValue('--red').trim(), night: cs.getPropertyValue('--night').trim().slice(0, 30) };
  })()`);
  check("live palette is the Studio ivory/ink/red set", palette.bg === "#fffbf7" && palette.ink === "#26100f" && ["#c82027", "#ca2b30"].includes(palette.red), palette);

  check("hero video carries a local hero source", await s.eval(`(document.querySelector('.hero-media [data-airport-video]')?.dataset.src || '').includes('airport-hero.mp4')`));
  check("hero video is muted, looping and inline", await s.eval(`(() => { const v = document.querySelector('.hero-media [data-airport-video]'); return v.muted && v.loop && v.playsInline; })()`));

  const live = await s.eval(`(async () => { const v = document.querySelector('.hero-media [data-airport-video]'); for (let i = 0; i < 50; i++) { if (v.classList.contains('is-live') && v.readyState >= 2) return { live: true, rate: v.playbackRate, t: v.currentTime }; await new Promise(r => setTimeout(r, 200)); } return { live: false, ready: v.readyState, src: v.currentSrc }; })()`, { awaitPromise: true });
  check("hero footage actually plays on the live site", live.live && Math.abs(live.rate - 0.65) < 0.01 && live.t > 0, live);

  await s.navigate(`${base}/#/book`);
  await waitFor(`!!document.querySelector('#login-open')`, "account control");
  await s.click("#login-open");
  await waitFor(`!document.querySelector('#account-modal').hidden`, "login dialog");
  check("login opens from the live booking page", await s.eval(`!document.querySelector('#account-modal').hidden`));
  check("login form is operable on the live site", await s.eval(`!document.querySelector('#login-submit').disabled && !!document.querySelector('#login-email') && !!document.querySelector('#login-password')`));

  await s.click("#account-close");
  await sleep(300);

  await s.navigate(`${base}/#/track`);
  await waitFor(`!!document.querySelector('#track-form') || !!document.querySelector('#track-code')`, "tracking form");
  check("tracking form renders live", await s.eval(`!!(document.querySelector('#track-form') || document.querySelector('#track-code'))`));

  const sw = await s.eval(`navigator.serviceWorker.getRegistration().then(r => r ? r.active?.scriptURL || 'registering' : 'none')`, { awaitPromise: true });
  check("service worker is registered live", typeof sw === "string" && sw.includes("sw.js"), sw);

  const man = await s.raw("Page.getAppManifest");
  const inst = await s.raw("Page.getInstallabilityErrors");
  check("the live manifest parses with no errors", man.url?.includes("site.webmanifest") && (man.errors || []).length === 0, man.errors);
  check("Chrome reports no reason the live app cannot be installed", (inst.installabilityErrors || []).length === 0, inst.installabilityErrors);
  check("the live worker controls the page", await s.eval(`!!navigator.serviceWorker.controller`));

  const errs = await s.eval(`window.__bhErrors || []`);
  check("no uncaught page errors", Array.isArray(errs) && errs.length === 0, errs);

  console.log(`\n${checks} live checks passed`);
} finally {
  s?.conn?.close?.();
  if (chrome?.pid) { try { process.kill(-chrome.pid, "SIGKILL"); } catch { try { chrome.kill("SIGKILL"); } catch {} } }
  await new Promise((r) => setTimeout(r, 400));
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
