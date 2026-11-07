/**
 * BrownHub Haul — real-browser end-to-end check.
 *
 * Boots its OWN server on a spare port with a throwaway DB and a throwaway
 * depot passphrase (so it never touches data/shipments.json), attaches to a
 * private headless Chrome over CDP, and drives the UI with TRUSTED mouse
 * clicks — the only way to prove the form, tracker and dispatch board actually
 * work for a traveller.
 *
 *   node .verify/ui.mjs
 *
 * Writes .verify/ui.log, .verify/ui-results.json and .verify/shots/*.png.
 */

import { spawn } from "node:child_process";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { bindPorts } from "./ports.mjs";
import { session } from "./cdp.mjs";

const ROOT = "/Users/brownhub/Documents/Qoder/2026-10-27/a6740f12";
const OUT = join(ROOT, ".verify");
const SHOTS = join(OUT, "shots");
const APP_PORT = 8813;
const CDP_PORT = 9413;
const DB = join(OUT, `e2e-${process.pid}.json`);
const PHOTOS = join(OUT, `e2e-photos-${process.pid}`);
const PROFILE = join(OUT, "chrome-profile");
const BASE = `http://127.0.0.1:${APP_PORT}`;
const LOG = join(OUT, "ui.log");
// A fresh passphrase every run: the board must refuse first and open second,
// and a hard-coded one would turn this suite into a test of the test.
const TOKEN = `BHDEPOT-TEST-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const IMAGE_FIXTURE = join(ROOT, "assets", "logo.png");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let logBuf = "";
const say = (...a) => {
  const msg = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  logBuf += msg + "\n";
  writeFile(LOG, logBuf).catch(() => {});
  process.stdout.write(msg.split("\n")[0] + "\n");
};

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail: cond ? undefined : detail });
  say(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : ` → ${JSON.stringify(detail)}`}`);
};

async function waitFor(s, expr, label, timeout = 9000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      const v = await s.eval(expr);
      if (v) return v;
    } catch { /* not rendered yet */ }
    await sleep(120);
  }
  const state = await s
    .eval(`({ url: location.href, ready: document.readyState, svc: document.querySelectorAll('#services .svc').length, body: document.body.children.length })`)
    .catch(() => "unreadable");
  throw new Error(`timed out waiting for ${label} · page=${JSON.stringify(state)} · errors=${JSON.stringify(liveErrors.slice(-4))}`);
}

const clearToasts = () => s.eval(`document.querySelectorAll('.toast').forEach(t => t.remove()); true`);
const setField = (sel, value) =>
  s.eval(
    `(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(value)};
      e.dispatchEvent(new Event('input', { bubbles: true })); return e.value; })()`
  );

let server, chrome, s;
let liveErrors = [];

try {
  await mkdir(SHOTS, { recursive: true });
  await bindPorts([APP_PORT, CDP_PORT]);

  say(`booting our server on ${APP_PORT} with throwaway db ${DB}`);
  server = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), HOST: "127.0.0.1", DB, PHOTOS, HAUL_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  server.stdout.on("data", (d) => say(`[server] ${d.toString().trim()}`));
  server.stderr.on("data", (d) => say(`[server:err] ${d.toString().trim()}`));

  let health = null;
  for (let i = 0; i < 50 && !health; i++) {
    await sleep(200);
    try { health = await (await fetch(`${BASE}/api/health`)).json(); } catch { /* not up */ }
  }
  // Prove this is OUR server, not a leftover answering on the same port.
  if (health?.db !== DB.split("/").pop()) throw new Error(`port ${APP_PORT} answered with foreign db: ${JSON.stringify(health)}`);
  say(`server ok · db=${health.db} · shipments=${health.shipments}`);

  say("launching private headless Chrome");
  await rm(PROFILE, { recursive: true, force: true });
  chrome = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
     "--window-size=1440,900",
     "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--disable-gpu",
     "--force-color-profile=srgb", "about:blank"],
    { stdio: "ignore", detached: true }
  );

  s = await session(CDP_PORT, say);
  liveErrors = s.consoleErrors();

  /* ————————————————————————— BOOK ————————————————————————— */
  await s.setSize(1440, 900);
  await s.navigate(`${BASE}/#/book`);
  await waitFor(s, `document.querySelectorAll('#services .svc').length === 3`, "booking form");

  const quote0 = await s.eval(`document.querySelector('#t-total').textContent`);
  check("live quote on load", /^GH₵[0-9.,]+$/.test(quote0), quote0);
  check("price breakdown populated", (await s.eval(`document.querySelectorAll('#price-lines li').length`)) >= 4);
  check("leg distance rendered", /km by road/.test(await s.eval(`document.querySelector('#leg-txt').textContent`)));
  check("default route is Kokomlemle → KIA", (await s.eval(`document.querySelector('#fromId').value`)) === "kokomlemle" && (await s.eval(`document.querySelector('#toId').value`)) === "kotoka");
  await s.shot(join(SHOTS, "01-book-1440.png"));

  await s.pick("#toId", "kmasoku");
  const quote1 = await s.eval(`document.querySelector('#t-total').textContent`);
  check("price reacts to the route", quote1 !== quote0, { quote0, quote1 });
  check("leg text follows the route", /Kumasi/.test(await s.eval(`document.querySelector('#leg-txt').textContent`)));

  await s.type("#customerName", "Ama Boateng");
  await s.type("#customerPhone", "+233 53 558 3460");
  await s.type("#address", "No. 14 Olive Drive, House 3");

  const stdPrice = await s.eval(`document.querySelector('#t-total').textContent`);
  await s.click(`label[data-svc="sameday"]`);
  await sleep(300);
  const vipPrice = await s.eval(`document.querySelector('#t-total').textContent`);
  check("clicking a service tier reprices", vipPrice !== stdPrice, { stdPrice, vipPrice });
  check("chosen tier is highlighted", await s.eval(`document.querySelector('label[data-svc="sameday"]').classList.contains('on')`));

  /* A tier's advertised window must be the window the form can actually book, and the
     card copy must state the same promise the quote line makes. */
  const earlyWindow = `[...document.querySelector('#pickupWindow').options].find(o => o.value === '06:00 – 08:00').disabled`;
  await s.eval(`(() => { const sel = document.querySelector('#pickupWindow');
    sel.value = '06:00 – 08:00'; sel.dispatchEvent(new Event('change', { bubbles: true })); return sel.value; })()`);
  await sleep(250);
  check("same-day opens the 06:00 window", (await s.eval(earlyWindow)) === false);
  check("same-day books it", (await s.eval(`document.querySelector('#pickupWindow').value`)) === "06:00 – 08:00");
  check("the window note names the tier's hours", /06:00 – 22:00/.test(await s.eval(`document.querySelector('#window-note').textContent`)));
  const promise = (t) => (t.match(/within \d+ (?:working hours|minutes)/) || [""])[0];
  const vipCopy = await s.eval(`({ blurb: document.querySelector('label[data-svc="sameday"] p').textContent, sla: document.querySelector('#sla-note').textContent })`);
  check("card copy and quote line state the same promise", !!promise(vipCopy.blurb) && promise(vipCopy.blurb) === promise(vipCopy.sla), vipCopy);
  await s.click(`label[data-svc="standard"]`);
  await sleep(300);
  check("standard closes the pre-09:00 window", (await s.eval(earlyWindow)) === true);
  const fellBack = await s.eval(`document.querySelector('#pickupWindow').value`);
  check("an unbookable window falls back to one that is", fellBack === "10:00 – 12:00", fellBack);
  await s.click(`label[data-svc="sameday"]`);
  await sleep(300);

  const linesNow = await s.eval(`[...document.querySelectorAll('#price-lines li')].map(l=>l.textContent).join('|')`);
  check("transit cover priced while insured", /Transit cover/.test(linesNow), linesNow.slice(0, 120));
  await s.click("#insurance"); // the box starts ticked — untick it
  await sleep(250);
  const linesOff = await s.eval(`[...document.querySelectorAll('#price-lines li')].map(l=>l.textContent).join('|')`);
  check("un-ticking cover removes the line", !/Transit cover/.test(linesOff) && linesOff !== linesNow, linesOff.slice(0, 120));
  await s.click("#insurance");
  await sleep(250);
  check("re-ticking cover restores it", /Transit cover/.test(await s.eval(`[...document.querySelectorAll('#price-lines li')].map(l=>l.textContent).join('|')`)));

  await s.click("#submit-btn");
  await waitFor(s, `!document.querySelector('#confirm').hidden`, "confirmation modal");
  const code = await s.eval(`document.querySelector('#conf-code').textContent`);
  const pin = (await s.eval(`document.querySelector('#conf-pin').textContent`)).trim();
  check("booking accepted, code issued", /^BH-[A-Z2-9]{6}$/.test(code), code);
  check("handover PIN issued", /^\d{4}$/.test(pin), pin);
  const wa = await s.eval(`document.querySelector('#conf-wa').href`);
  check("WhatsApp handoff carries the code", wa.includes("wa.me/233535583460") && wa.includes(encodeURIComponent(code)), wa.slice(0, 80));
  await s.shot(join(SHOTS, "02-confirmed.png"));

  const apiRow = await (await fetch(`${BASE}/api/shipments/${code}`)).json();
  check("booking persisted server-side", apiRow.ok === true && apiRow.status === "booked", apiRow.status);
  check("service + address persisted", apiRow.logistics?.service === "sameday" && apiRow.address === "No. 14 Olive Drive, House 3", apiRow.logistics?.service);
  const uiTotal = parseFloat(vipPrice.replace(/[^\d.]/g, ""));
  check("server price matches the live preview", Math.abs(apiRow.total - uiTotal) < 0.02 || Math.abs(apiRow.total - parseFloat((await s.eval(`document.querySelector('#conf-total').textContent`)).replace(/[^\d.]/g, ""))) < 0.02, { ui: vipPrice, conf: await s.eval(`document.querySelector('#conf-total').textContent`), api: apiRow.total });

  /* ————————————————————————— TRACK ————————————————————————— */
  await s.click("#conf-track");
  await waitFor(s, `!!document.querySelector('.track-card')`, "tracking card");
  check("Track CTA dismissed the confirmation dialog", await s.eval(`document.querySelector('#confirm').hidden`));
  check("timeline shows the whole ladder", (await s.eval(`document.querySelectorAll('.tl li').length`)) >= 6);
  check("only reached stages are marked", (await s.eval(`document.querySelectorAll('.tl li.done, .tl li.now').length`)) === 1, await s.eval(`document.querySelectorAll('.tl li.done, .tl li.now').length`));
  check("tracker names the route", /Kokomlemle/.test(await s.eval(`document.querySelector('.route-strip').textContent`)));
  // the strip reads distance from the stored quote; a shape change here used to print "— km"
  check("tracker states the leg distance", /\d+(\.\d+)?\s*km/.test(await s.eval(`document.querySelector('.route-strip').textContent`)), await s.eval(`document.querySelector('.route-strip').textContent`));
  await s.shot(join(SHOTS, "03-track-1440.png"));

  // a wrong PIN must be refused, the right one accepted — the driver's handover gate
  await clearToasts();
  await s.type(".pinbox input", "0000");
  await s.click(".pinbox button");
  await waitFor(s, `!!document.querySelector('.toast.bad')`, "wrong-PIN toast");
  const badToast = await s.eval(`document.querySelector('.toast.bad').textContent`);
  check("wrong PIN refused", /does not match/i.test(badToast), badToast);
  check("refusal is a sentence, not a status code", !/422|Request failed/i.test(badToast), badToast);
  await clearToasts();
  await setField(".pinbox input", "");
  await s.type(".pinbox input", pin);
  await s.click(".pinbox button");
  await waitFor(s, `!!document.querySelector('.toast.ok')`, "right-PIN toast");
  const okToast = await s.eval(`document.querySelector('.toast.ok').textContent`);
  check("correct PIN accepted", /Handover accepted/i.test(okToast), okToast);

  const hash = await s.eval(`location.hash`);
  check("tracker URL is shareable", hash === `#/track/${code}`, hash);

  /* ————————————————————————— DISPATCH ————————————————————————— */
  await s.navigate(`${BASE}/#/dispatch`);
  await waitFor(s, `!!document.querySelector('.lock-panel')`, "locked dispatch");
  check("the board opens locked, not empty", /Dispatch is locked/i.test(await s.eval(`document.querySelector('#board').textContent`)));
  check("the lockbar says why", /Locked — the manifest needs the depot passphrase/.test(await s.eval(`document.querySelector('#lockbar').textContent`)));
  check("a locked board leaks no traveller", !/Ama Boateng|Kojo|Olive Drive|\d{4}/.test(await s.eval(`document.querySelector('#board').textContent`)), (await s.eval(`document.querySelector('#board').textContent`)).slice(0, 60));
  check("a locked board draws no stats", (await s.eval(`document.querySelectorAll('.stat').length`)) === 0);
  await s.shot(join(SHOTS, "04a-locked.png"));

  await setField("#unlock-token", "BHDEPOT-WRONG-WRONG-WRONG");
  await s.click(".lock-panel button[type=submit]");
  await waitFor(s, `!!document.querySelector('.lock-panel .err-box')`, "refused passphrase");
  check("a wrong passphrase is refused in words", /passphrase was refused/i.test(await s.eval(`document.querySelector('.lock-panel .err-box').textContent`)));
  check("the refusal still shows no manifest", (await s.eval(`document.querySelectorAll('.row').length`)) === 0);
  await s.shot(join(SHOTS, "04b-refused.png"));

  await setField("#unlock-token", TOKEN);
  await s.click(".lock-panel button[type=submit]");
  await waitFor(s, `!!document.querySelector('.row')`, "dispatch rows");
  check("the passphrase unlocks the board", (await s.eval(`document.querySelectorAll('.row').length`)) >= 2);
  check("the lockbar now says unlocked", /Unlocked for this shift/.test(await s.eval(`document.querySelector('#lockbar').textContent`)));
  check("stats tiles render", (await s.eval(`document.querySelectorAll('.stat').length`)) === 7, await s.eval(`document.querySelectorAll('.stat').length`));
  await s.shot(join(SHOTS, "04c-dispatch-1440.png"));

  const publicRow = await (await fetch(`${BASE}/api/shipments/${code}`)).text();
  check("the same read without the passphrase has no PIN", !publicRow.includes(pin) && !/pinSeal/.test(publicRow), publicRow.slice(0, 60));
  check("and it masks the phone", !publicRow.includes("+233 55 111 2222") && /\u2022\u2022\u2022/.test(publicRow), publicRow.match(/"phone":"[^"]*"/)?.[0]);

  await s.clickExpr(
    `[...document.querySelectorAll('.row')].find(r => r.dataset.code === ${JSON.stringify(code)})?.querySelector('[data-act="advance"]')`,
    "advance button"
  );
  await sleep(900);
  const afterAdvance = await (await fetch(`${BASE}/api/shipments/${code}`)).json();
  check("dispatch advances the haul", afterAdvance.status === "collected", afterAdvance.status);
  const last = afterAdvance.history.at(-1);
  check("collector event written to the history", last.status === "collected" && last.by === "board" && /sealed/.test(last.note), last);

  await s.clickExpr(
    `[...document.querySelectorAll('.row')].find(r => r.dataset.code === ${JSON.stringify(code)})?.querySelector('[data-act="toggle"]')`,
    "details toggle"
  );
  await sleep(250);
  check("row details expand with the PIN visible", (await s.eval(`document.querySelector('.row.open .row-detail')?.textContent || ''`)).includes(pin));
  check("the PIN reached the desk unsealed, not as a blob", !/aes256gcm|pinSeal/.test(await s.eval(`document.querySelector('.row.open .row-detail')?.textContent || ''`)));

  /* ——————————————— CUSTODY PHOTO: capture → post → tracker ——————————————— */
  // A real <input type=file> fed by CDP — the same code path a collector's
  // phone runs when they photograph the sealed bags at the door.
  const shotsBefore = await s.eval(`document.querySelectorAll('.row.open .shot img').length`);
  await s.setFiles(`.row[data-code="${code}"] input[data-photo]`, [IMAGE_FIXTURE]);
  await waitFor(s, `document.querySelectorAll('.row[data-code="${code}"] .shot img').length > ${shotsBefore}`, "uploaded photo on the board", 12000);
  // The board reloads after a post — it must come back with the haul the desk just
  // photographed still open, so the shot is visible without hunting for it again.
  check("the row stays open after the upload", (await s.eval(`document.querySelector('.row[data-code="${code}"]')?.classList.contains('open')`)) === true);
  await waitFor(s, `document.querySelector('.row[data-code="${code}"] .shot img')?.naturalWidth > 0`, "photo decoded by the browser", 8000);
  const shotInfo = await s.eval(`(() => { const i = document.querySelector('.row[data-code="${code}"] .shot img');
    return { src: i.getAttribute('src'), w: i.naturalWidth, h: i.naturalHeight, alt: i.alt }; })()`);
  check("the collector's photo appears on the board", /^photos\/BH-[A-Z2-9]{6}\/[\w.-]+\.(jpg|png)$/.test(shotInfo.src), shotInfo);
  check("the browser really decoded it", shotInfo.w > 0 && shotInfo.h > 0, shotInfo);
  check("the shot is downscaled before it is posted", shotInfo.w <= 1280, shotInfo);
  const boardToast = await s.eval(`[...document.querySelectorAll('.toast')].map(t => t.textContent).join('|')`);
  check("the board reports how many photos landed", /custody photo/i.test(boardToast), boardToast.slice(0, 80));
  await s.shot(join(SHOTS, "04d-photo-on-board.png"));

  const photoRow = await (await fetch(`${BASE}/api/shipments/${code}`, { headers: { "x-haul-token": TOKEN } })).json();
  check("the photo is on the manifest record", photoRow.photos?.length === 1 && /Custody photo 1 added/.test(JSON.stringify(photoRow.history)), photoRow.photos);
  check("the stored file is the resized JPEG the page sent", /\.jpg$/.test(photoRow.photos?.[0]?.url || ""), photoRow.photos);
  const statsAfter = await s.eval(`[...document.querySelectorAll('.stat')].map(x=>x.textContent).join('|')`);
  check("the photos counter moved", /Custody photos[1-9]/.test(statsAfter), statsAfter.slice(-40));

  await s.navigate(`${BASE}/#/track/${code}`);
  await waitFor(s, `!!document.querySelector('.gallery .shot img')`, "custody photo on the tracker");
  const trackerShot = await s.eval(`(() => { const i = document.querySelector('.gallery .shot img');
    return { src: i.getAttribute('src'), w: i.naturalWidth, alt: i.alt, lbl: document.querySelector('.gallery .lbl')?.textContent }; })()`);
  check("the traveller sees the photo of their own bag", trackerShot.w > 0 && trackerShot.src === photoRow.photos[0].url, trackerShot);
  check("the tracker names the stage the photo proves", /Photographed at collection/.test(trackerShot.lbl || ""), trackerShot.lbl);
  await s.shot(join(SHOTS, "04e-photo-tracker.png"), { full: true });

  // The app must never claim a picture that was not taken. This haul has no photos
  // attached, so the word "photo" may not appear anywhere on its tracker — not in a
  // stage note, not in a "no photo" apology line, not at all.
  await s.navigate(`${BASE}/#/track/BH-D3MO24`);
  await waitFor(s, `!!document.querySelector('.track-card')`, "demo tracker");
  const demoTrack = await s.eval(`document.querySelector('.track-card').textContent`);
  check("a haul with no photo says nothing about photos", !/photo/i.test(demoTrack), demoTrack.replace(/\s+/g, " ").match(/.{0,44}photo.{0,44}/i)?.[0] ?? "");
  check("and no stage note claims a custody shot", !/chain.of.custody photo/i.test(demoTrack), demoTrack.slice(0, 60));

  /* back to the board for the remaining filter checks */
  await s.navigate(`${BASE}/#/dispatch`);
  await waitFor(s, `!!document.querySelector('.row')`, "dispatch rows again");

  await s.click(`[data-status="delivered"]`);
  await sleep(800);
  const deliveredOnly = await s.eval(`[...document.querySelectorAll('#board .badge')].map(b=>b.textContent.trim()).join(',')`);
  check("status filter narrows the board", deliveredOnly.length === 0 || !/Collected/.test(deliveredOnly), deliveredOnly);
  await s.click(`[data-status="all"]`);
  await sleep(700);
  await setField("#board-q", "");
  await s.type("#board-q", "zzzznothing");
  await sleep(800);
  const noMatch = await s.eval(`document.querySelector('#board')?.textContent || ''`);
  check("a search with no match says so", /Nothing on the manifest/i.test(noMatch), noMatch.slice(0, 60));
  await setField("#board-q", "");
  await sleep(400);
  await s.type("#board-q", code);
  await sleep(900);
  const foundRows = await s.eval(`document.querySelectorAll('.row').length`);
  check("search finds the haul by code", foundRows === 1, { foundRows, box: await s.eval(`document.querySelector('#board-q').value`) });

  /* ————————————————————————— RESPONSIVE ————————————————————————— */
  const overflow = [];
  for (const [w, h, mob] of [[1440, 900, false], [1280, 800, false], [834, 1112, false], [390, 844, true], [360, 740, true], [320, 568, true]]) {
    await s.setSize(w, h, mob);
    // A unique query string forces a REAL document load — navigate() to the same
    // path with a different #hash is a same-document hop that fires no load event,
    // and the reload then races whatever was still in flight.
    await s.navigate(`${BASE}/?probe=${w}x${h}#/book`);
    await waitFor(s, `document.querySelectorAll('#services .svc').length === 3`, `book form at ${w}px`);
    await sleep(300);
    const o = await s.eval(`({ w: innerWidth, sw: document.documentElement.scrollWidth })`);
    if (o.sw > o.w + 1) overflow.push(`${o.w}px → scrollWidth ${o.sw}`);
  }
  check("no horizontal overflow at 6 widths", overflow.length === 0, overflow);

  await s.setSize(390, 844, true);
  await s.navigate(`${BASE}/#/book`);
  await waitFor(s, `document.querySelectorAll('#services .svc').length === 3`, "book form at 390px");
  await s.shot(join(SHOTS, "05-book-390.png"), { full: true });
  await s.navigate(`${BASE}/#/track/${code}`);
  await waitFor(s, `!!document.querySelector('.track-card')`, "track card at 390px");
  await s.shot(join(SHOTS, "06-track-390.png"), { full: true });
  await s.setSize(1440, 900);

  const fontsOK = await s.eval(`document.fonts.check('600 16px Poppins')`);
  say(`typeface: Poppins ${fontsOK ? "resolved" : "NOT resolved — fell back"}`);
  // a fact, not an assertion: every price on the page carries ₵, and if the brand
  // face has no glyph the browser substitutes a different one mid-number.
  const cediOK = await s.eval(`document.fonts.check('600 16px Poppins', '₵')`);
  say(`typeface: cedi sign ${cediOK ? "in Poppins" : "MISSING from Poppins — prices mix two faces"}`);

  /* ————————————————————————— RESULT ————————————————————————— */
  // Two probes deliberately fail: the wrong handover PIN (422) and the board
  // before it is unlocked (401). Anything else non-2xx is a real bug.
  const real = liveErrors.filter((e) => !/favicon|net::ERR_|chrome:\/\/|DevTools|Failed to load resource/i.test(e));
  const wrongPin = real.filter((e) => /^http 422 .*\/api\/shipments\//.test(e));
  const locked = real.filter((e) => /^http 401 .*\/api\/shipments/.test(e));
  const unexpected = real.filter((e) => !/^http (422|401) .*\/api\/shipments/.test(e));
  check("the two deliberate probes are the only failed responses", real.length === wrongPin.length + locked.length, real.slice(0, 6));
  check("the wrong-PIN probe fired exactly once", wrongPin.length === 1, wrongPin);
  check("the locked board was refused by the API, not just hidden by CSS", locked.length >= 2, locked.length);
  check("no console errors or exceptions", unexpected.length === 0, unexpected.slice(0, 6));

  const failed = results.filter((r) => !r.pass);
  say(`\n${results.length - failed.length}/${results.length} browser assertions passed`);
  failed.forEach((f) => say(`   · ${f.name}: ${JSON.stringify(f.detail)}`));
  await writeFile(join(OUT, "ui-results.json"), JSON.stringify({ passed: results.length - failed.length, total: results.length, results }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  say("!! " + (e?.stack || e));
  process.exitCode = 1;
} finally {
  const kill = (p, tag) => {
    if (!p?.pid) return;
    try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch { say(`(could not kill ${tag})`); } }
  };
  s?.conn?.close?.();
  kill(chrome, "chrome");
  kill(server, "server");
  await sleep(400);
  await rm(DB, { force: true });
  await rm(PHOTOS, { recursive: true, force: true });
  await rm(PROFILE, { recursive: true, force: true });
  try { await bindPorts([APP_PORT, CDP_PORT]); say("teardown clean · ports free"); }
  catch (e) { say("!! ports still busy after teardown — " + e.message); }
}
