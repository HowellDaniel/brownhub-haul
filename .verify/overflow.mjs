/** Overflow probe: which elements stick out past the viewport, with the page
 *  carrying real data (a seeded booking + a tracked code + an UNLOCKED board
 *  holding a custody photo), not an empty reload. */
import { spawn } from "node:child_process";
import { bindPorts } from "./ports.mjs";
import { session } from "./cdp.mjs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";

const ROOT = "/Users/brownhub/Documents/Qoder/2026-10-27/a6740f12";
const APP = 8817, CDP = 9417, DB = join(ROOT, ".verify", `ovf-${process.pid}.json`);
const PHOTOS = join(ROOT, ".verify", `ovf-photos-${process.pid}`);
const PROFILE = join(ROOT, ".verify", "ovf-profile");
const TOKEN = `BHDEPOT-OVF-${process.pid}`;
const BASE = `http://127.0.0.1:${APP}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [join(ROOT, "server.mjs")], {
  cwd: ROOT, env: { ...process.env, PORT: String(APP), DB, PHOTOS, HAUL_TOKEN: TOKEN }, stdio: "ignore", detached: true,
});
let chrome;
try {
  await bindPorts([APP, CDP]);
  for (let i = 0; i < 40; i++) { try { await fetch(`${BASE}/api/health`); break; } catch { await sleep(200); } }

  // Give the seeded haul a photo and two stages first: the probe must measure the
  // widest thing the board can really render, not a tidy empty row.
  const png = readFileSync(join(ROOT, "assets", "logo.png")).toString("base64");
  const H = { "content-type": "application/json", "x-haul-token": TOKEN };
  await fetch(`${BASE}/api/shipments/BH-D3MO24`, { method: "PATCH", headers: H, body: JSON.stringify({ note: "sealed at the door" }) });
  const ph = await fetch(`${BASE}/api/shipments/BH-D3MO24/photos`, {
    method: "POST", headers: H,
    body: JSON.stringify({ data: `data:image/png;base64,${png}`, note: "two cases and a suitcase, sealed and taped at the front door" }),
  });
  console.log(`seeded custody photo: ${ph.status} ${(await ph.json())?.photo?.url || ""}`);

  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`, "--window-size=1440,900",
     "--no-first-run", "--hide-scrollbars", "--disable-gpu", "about:blank"], { stdio: "ignore", detached: true });
  const s = await session(CDP, () => {});
  const problems = [];

  // Walk the board with the depot passphrase already in the tab, or every
  // dispatch measurement is taken on the unlock panel instead of the manifest.
  await s.navigate(`${BASE}/#/book`);
  await s.eval(`sessionStorage.setItem('haul.dispatch.token', ${JSON.stringify(TOKEN)}); true`);

  const PROBE = `(() => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    /** A child of a deliberately scrollable box (the status filter swipes sideways on
     *  a phone) is not a page overflow. Only report it if the SCROLLER itself is what
     *  sticks out — otherwise the probe cries wolf and stops being trusted. */
    const clippedBy = (el) => {
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        if (ox === 'auto' || ox === 'scroll') return a.getBoundingClientRect().right <= vw + 1;
      }
      return false;
    };
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.classList.contains('skip')) continue; // deliberately parked off-screen
      if ((r.right > vw + 1 || r.left < -1) && !clippedBy(el)) {
        const cs = getComputedStyle(el);
        out.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 44),
                   id: el.id || '', left: Math.round(r.left), right: Math.round(r.width + r.left),
                   sw: document.documentElement.scrollWidth, overflowX: cs.overflowX, ws: cs.whiteSpace });
      }
    }
    return { innerWidth, vw, cw: document.documentElement.clientWidth, vv: visualViewport && Math.round(visualViewport.width),
           scrollWidth: document.documentElement.scrollWidth, offenders: out.slice(0, 14) };
  })()`;

  const verdict = (label, r) => {
    const over = r.scrollWidth > r.cw + 1;
    if (over) problems.push(`${label}: page is ${r.scrollWidth}px wide in a ${r.cw}px viewport`);
    console.log(`\n${label} → ${JSON.stringify({ innerWidth: r.innerWidth, clientWidth: r.cw, visual: r.vv, scrollWidth: r.scrollWidth })}${over ? "  !! OVERFLOW" : ""}`);
    for (const o of r.offenders) console.log("   ", JSON.stringify(o));
    if (!r.offenders.length) console.log("    clean");
  };

  for (const route of ["/#/book", "/#/track/BH-D3MO24", "/#/dispatch"]) {
    for (const [w, h] of [[390, 844], [320, 568]]) {
      await s.setSize(w, h, true);
      // a unique query per pass = a real document load; a bare #hash hop fires no load event
      await s.navigate(`${BASE}/?p=${w}${route}`);
      if (route === "/#/dispatch") {
        for (let i = 0; i < 30 && !(await s.eval(`!!document.querySelector('.row')`)); i++) await sleep(200);
        await s.eval(`document.querySelectorAll('.row').forEach(r => r.classList.add('open')); true`);
      }
      await sleep(900);
      verdict(`${route}${route === "/#/dispatch" ? " (unlocked, rows open)" : ""} @ ${w}px`, await s.eval(PROBE));
    }
  }
  // also a wide-content booking: long leg text
  await s.setSize(390, 844, true);
  await s.navigate(`${BASE}/?p=long#/book`);
  await sleep(1200);
  await s.eval(`(() => { const f=document.getElementById('book-form');
    document.getElementById('toId').value='kmasoku';
    document.getElementById('toId').dispatchEvent(new Event('change',{bubbles:true}));
    document.getElementById('fromId').value='themelincoln';
    document.getElementById('fromId').dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  await sleep(600);
  const r2 = await s.eval(PROBE);
  verdict("#/book longest leg text @ 390px", r2);
  console.log("    leg:", await s.eval(`document.querySelector('#leg-txt').textContent`));

  console.log(problems.length ? `\n!! ${problems.length} overflowing viewports:\n   ` + problems.join("\n   ") : "\nno page overflow at any probed width");
  process.exitCode = problems.length ? 1 : 0;
} catch (e) {
  console.error("probe failed:", e.message);
  process.exitCode = 1;
} finally {
  // Group-kill AND pid-kill: a detached Chrome survives one of them, and a
  // leftover holding 8817/9417 makes the next run fail on "port busy".
  for (const p of [chrome, server]) {
    if (!p?.pid) continue;
    try { process.kill(-p.pid, "SIGKILL"); } catch {}
    try { p.kill("SIGKILL"); } catch {}
  }
  await sleep(600);
  try { await bindPorts([APP, CDP]); console.log("teardown clean · ports free"); }
  catch (e) { console.log("!! " + e.message); }
  await rm(DB, { force: true });
  await rm(PHOTOS, { recursive: true, force: true });
  await rm(PROFILE, { recursive: true, force: true });
}
