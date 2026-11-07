/** Readable visual check: element-targeted viewport tiles (not one 10000px strip,
 *  which downscales to mush in the viewer). Own server, own db, own profile. */
import { spawn } from "node:child_process";
import { bindPorts } from "./ports.mjs";
import { session } from "./cdp.mjs";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";

const ROOT = "/Users/brownhub/Documents/Qoder/2026-10-27/a6740f12";
const APP = 8815, CDP = 9415;
const DB = join(ROOT, ".verify", `tiles-${process.pid}.json`);
const PHOTOS = join(ROOT, ".verify", `tiles-photos-${process.pid}`);
const PROFILE = join(ROOT, ".verify", "tiles-profile");
const OUT = join(ROOT, ".verify", "shots", "tiles");
// The board is gated, so a tile run needs a passphrase of its own — and the
// harness must unlock it, or every dispatch screenshot is the lock panel.
const TOKEN = `BHDEPOT-TILES-${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [join(ROOT, "server.mjs")], {
  cwd: ROOT, env: { ...process.env, PORT: String(APP), DB, PHOTOS, HAUL_TOKEN: TOKEN }, stdio: "ignore", detached: true,
});
let chrome;
await mkdir(OUT, { recursive: true });

/** Scrolls the target into view, then captures exactly the viewport. */
const tile = async (s, sel, name, { align = "start", dy = 0 } = {}) => {
  await s.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) throw new Error("missing " + ${JSON.stringify(sel)});
    e.scrollIntoView({ block: ${JSON.stringify(align)}, inline: "nearest", behavior: "instant" });
    window.scrollBy(0, ${dy}); return [Math.round(scrollY), ${JSON.stringify(name)}]; })()`);
  await sleep(320);
  await s.shot(join(OUT, name + ".png"));
};

try {
  await bindPorts([APP, CDP]);
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${APP}/api/health`); break; } catch { await sleep(200); } }
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`, "--window-size=1440,900",
     "--no-first-run", "--hide-scrollbars", "--disable-gpu", "about:blank"], { stdio: "ignore", detached: true });
  const s = await session(CDP, (m) => console.log("   ·", m));

  const wait = async (expr, label, tries = 60) => {
    for (let i = 0; i < tries; i++) { if (await s.eval(expr)) return; await sleep(150); }
    throw new Error("timeout waiting for " + label);
  };

  /* ————— phone, 390×844 ————— */
  await s.setSize(390, 844, true);
  await s.navigate(`http://127.0.0.1:${APP}/#/book`);
  await wait(`document.querySelectorAll('#services .svc').length === 3`, "book form");
  await tile(s, ".hero", "m1-hero");
  await tile(s, "#legline", "m2-route-and-address", { dy: -120 });
  await tile(s, "#services", "m3-service-tiers", { dy: -60 });
  await tile(s, ".summary", "m4-live-quote", { dy: -30 });

  await s.navigate(`http://127.0.0.1:${APP}/#/track/BH-D3MO24`);
  await wait(`!!document.querySelector('.track-card')`, "track card");
  await tile(s, ".route-strip", "m5-track-head", { dy: -160 });
  await tile(s, ".tl", "m6-timeline", { dy: -70 });
  await tile(s, ".now-card", "m7-details", { dy: -40 });

  // The board is gated now, so a tile run has to walk the real door: refuse a bad
  // passphrase, type the good one, and only then shoot a manifest.
  await s.navigate(`http://127.0.0.1:${APP}/#/dispatch`);
  await wait(`!!document.querySelector('.lock-panel')`, "locked dispatch");
  await tile(s, "#board", "m8-board-locked");

  await s.eval(`(() => { const i = document.getElementById('unlock-token'); i.value = "BHDEPOT-NOPE-NOPE"; i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await s.click(".lock-panel button[type=submit]");
  await wait(`!!document.querySelector('.lock-panel .err-box')`, "refused passphrase");
  await tile(s, "#board", "m9-board-refused", { dy: -40 });

  await s.eval(`(() => { const i = document.getElementById('unlock-token'); i.value = ${JSON.stringify(TOKEN)}; i.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  await s.click(".lock-panel button[type=submit]");
  await wait(`document.querySelectorAll('.row').length > 0`, "unlocked dispatch rows");
  await tile(s, ".stats", "m10-dispatch-stats", { dy: -70 });

  // open the demo haul and attach a real custody shot, so the photos tile and the
  // camera control are both in the picture rather than hypothetical
  await s.clickExpr(`[...document.querySelectorAll('.row')].find(r => r.dataset.code === "BH-D3MO24")?.querySelector('[data-act="advance"]')`, "advance");
  await sleep(900);
  await s.clickExpr(`[...document.querySelectorAll('.row')].find(r => r.dataset.code === "BH-D3MO24")?.querySelector('[data-act="toggle"]')`, "toggle");
  await sleep(250);
  await s.setFiles(`.row[data-code="BH-D3MO24"] input[data-photo]`, [join(ROOT, "assets", "logo.png")]);
  await wait(`document.querySelector('.row[data-code="BH-D3MO24"] .shot img')?.naturalWidth > 0`, "custody photo on the board", 20000);
  await tile(s, `.row[data-code="BH-D3MO24"]`, "m11-row-with-photo", { dy: -30 });

  /* ————— desktop, 1440×900 ————— */
  await s.setSize(1440, 900, false, 2);
  await s.navigate(`http://127.0.0.1:${APP}/#/book`);
  await wait(`document.querySelectorAll('#services .svc').length === 3`, "book form");
  await tile(s, ".split", "d1-split");
  await tile(s, ".summary", "d2-summary", { dy: -140 });

  // the passphrase is still in this tab's sessionStorage — the same shift the desk
  // is working, and exactly why the token lives there and not in localStorage
  await s.navigate(`http://127.0.0.1:${APP}/#/dispatch`);
  await wait(`document.querySelectorAll('.row').length > 0`, "dispatch rows");
  await tile(s, "#board", "d3-board", { dy: -80 });
  await s.clickExpr(`[...document.querySelectorAll('.row')].find(r => r.dataset.code === "BH-D3MO24")?.querySelector('[data-act="toggle"]')`, "toggle");
  await sleep(400);
  await tile(s, `.row[data-code="BH-D3MO24"]`, "d4-row-with-photo", { dy: -60 });

  console.log("tiles written →", OUT);
} finally {
  for (const p of [chrome, server]) {
    if (!p?.pid) continue;
    try { process.kill(-p.pid, "SIGKILL"); } catch {}
    try { p.kill("SIGKILL"); } catch {}
  }
  await sleep(500);
  await rm(DB, { force: true });
  await rm(PHOTOS, { recursive: true, force: true });
  await rm(PROFILE, { recursive: true, force: true });
  try { await bindPorts([APP, CDP]); console.log("teardown clean · ports free"); }
  catch (e) { console.log("!! " + e.message); }
}
