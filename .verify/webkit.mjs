/** WebKit coverage for BrownHub Haul.
 *
 *  The CDP suite proves the app works on Blink. This proves the same page on
 *  Apple's WebKit — the engine in every iPhone Safari, and the one a traveller's
 *  phone will actually use — because WebKit decides flex min-content, grid
 *  tracks and intrinsic SVG sizes differently, and a green Blink run cannot see
 *  a WebKit-only layout fault.
 *
 *  Each scenario is ONE probe process: an off-screen-window WKWebView loads a
 *  real URL, runs one measurement and prints one JSON line. No multi-call state
 *  — a sleeping probe in a hidden engine is where stale readings come from.
 *
 *    node .verify/webkit.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, chmodSync, statSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bindPorts } from "./ports.mjs";

const ROOT = "/Users/brownhub/Documents/Qoder/2026-10-27/a6740f12";
const OUT = join(ROOT, ".verify");
const WK = join(OUT, "webkit");
const BIN = join(WK, "probe");
const SRC = join(WK, "probe.swift");
const APP = 8819, DB = join(OUT, `wk-${process.pid}.json`), PHOTOS = join(OUT, `wk-photos-${process.pid}`);
const TOKEN = `BHDEPOT-WK-${process.pid}`;
const BASE = `http://127.0.0.1:${APP}`;
const SHOTS = join(OUT, "shots", "webkit");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEMO = "BH-D3MO24";
const DEMO_PIN = "4729"; // the seeded haul's PIN — the public tracker must never print it

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` → ${JSON.stringify(detail)}`}`);
};

/* ————————————————————————— the engine ————————————————————————— */

function buildProbe() {
  if (existsSync(BIN) && statSync(BIN).mtimeMs > statSync(SRC).mtimeMs) {
    console.log(`probe binary current (${BIN})`);
    return;
  }
  console.log("compiling the WKWebView probe (swiftc -O, once)");
  const r = spawnSync("xcrun", ["swiftc", "-O", SRC, "-o", BIN], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`swiftc failed:\n${r.stdout || ""}\n${r.stderr || ""}`);
  chmodSync(BIN, 0o755);
}

/** The contract with probe.swift: write a STRING to window.__probeOut, exactly
 *  once, after the page has fetched its own config. A body that needs to wait
 *  for a click sets `deferred = true` and calls `finish()` itself. */
const wrap = (body, settle = 2200) => `window.__probeOut = null;
var out = {}, deferred = false;
function finish () { window.__probeOut = JSON.stringify(out); }
setTimeout(function () {
  out.webkit = /AppleWebKit\\/[\\d.]+/.test(navigator.userAgent) && !/Chrom(e|ium)/.test(navigator.userAgent);
  out.poppinsCedi = document.fonts ? document.fonts.check('600 16px Poppins', '\\u20b5') : null;
  var de = document.documentElement;
  out.clientWidth = de.clientWidth;
  out.scrollWidth = de.scrollWidth;
  out.innerWidth = innerWidth;
  /** Deliberate swipe-scrollers and clipped media frames (the parallax hero is
   *  scaled past its bounds on purpose) are not page overflow. Measure the frame. */
  out.offenders = (function () {
    function clippedBy (el) {
      for (var a = el.parentElement; a && a !== de; a = a.parentElement) {
        var ox = getComputedStyle(a).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return a.getBoundingClientRect().right <= de.clientWidth + 1;
      }
      return false;
    }
    var list = [], all = document.querySelectorAll('body *');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.classList.contains('skip')) continue;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if ((r.right > de.clientWidth + 1 || r.left < -1) && !clippedBy(el)) {
        list.push(el.tagName.toLowerCase() + '.' + String(el.className || '').split(' ')[0] + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
      }
      if (list.length > 5) break;
    }
    return list;
  })();
  /** An off-screen window never ticks the animation timeline, and every view in
   *  this app enters with "animation: rise .32s both" — fill-mode both means the
   *  element sits at opacity 0 until a frame advances. Seek to the end state
   *  before measuring, or the snapshot is a blank page over a healthy DOM. */
  out.animsSeeked = (function () {
    var n = 0;
    if (document.getAnimations) document.getAnimations().forEach(function (a) { n++; try { a.finish(); } catch (e) {} });
    return n;
  })();
  out.viewOpacity = (function () { var v = document.querySelector('.view:not([hidden])'); return v ? getComputedStyle(v).opacity : null; })();
  try { ${body} } catch (e) { out.error = String((e && e.message) || e); finish(); return; }
  if (!deferred) finish();
}, ${settle});
void 0;`;

function probe(name, { url, w, h, js, token = null, settle = 2200, shot = null, ua = null }) {
  const file = join(WK, `${name}.js`);
  writeFileSync(file, js);
  const env = { ...process.env };
  if (token) env.PROBE_TOKEN = token;
  if (shot) env.SHOT = join(SHOTS, shot);
  if (ua) env.PROBE_UA = ua;
  const r = spawnSync(BIN, [url, String(w), String(h), file, String(settle + 14000)], { encoding: "utf8", env, timeout: settle + 30000 });
  if (r.error) throw new Error(`${name}: ${r.error.message}`);
  const line = (r.stdout || "").trim().split("\n").pop() || "";
  if (!line) throw new Error(`${name}: the probe printed nothing (status ${r.status}) ${r.stderr || ""}`);
  let out;
  try { out = JSON.parse(line); } catch { throw new Error(`${name}: not JSON → ${line.slice(0, 220)}`); }
  if (out.error) throw new Error(`${name}: probe threw → ${out.error}`);
  if (out.webkit === false) throw new Error(`${name}: that is not WebKit`);
  console.log(`\n${name} @ ${w}x${h}${token ? " [unlocked]" : ""} → ${JSON.stringify(out)}`);
  return out;
}

/* ————————————————————————— the scenarios ————————————————————————— */

let server;
try {
  mkdirSync(WK, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  buildProbe();
  await bindPorts([APP]);

  server = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP), HOST: "127.0.0.1", DB, PHOTOS, HAUL_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  server.stdout.resume();
  server.stderr.resume();
  let up = null;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(200);
    try { const h = await (await fetch(`${BASE}/api/health`)).json(); if (h.db === DB.split("/").pop()) up = h; } catch { /* not yet */ }
  }
  if (!up) throw new Error("the WebKit server never came up on its own port");

  // a haul with a driver and a custody photo, so WebKit measures the widest real state
  const H = { "content-type": "application/json", "x-haul-token": TOKEN };
  const png = readFileSync(join(ROOT, "assets", "logo.png")).toString("base64");
  await fetch(`${BASE}/api/shipments/${DEMO}`, { method: "PATCH", headers: H, body: JSON.stringify({ note: "sealed at the door" }) });
  await fetch(`${BASE}/api/shipments/${DEMO}`, { method: "PATCH", headers: H, body: JSON.stringify({ status: "out_for_delivery" }) });
  const ph = await (await fetch(`${BASE}/api/shipments/${DEMO}/photos`, {
    method: "POST", headers: H, body: JSON.stringify({ data: `data:image/png;base64,${png}`, note: "sealed at the door" }),
  })).json();
  const photoUrl = ph?.photo?.url;
  if (!photoUrl) throw new Error(`seeding the custody photo failed: ${JSON.stringify(ph)}`);
  console.log(`seeded ${DB.split("/").pop()} · photo ${photoUrl}`);

  /* 1 — booking on an iPhone-sized WebKit, and a real click on a tier */
  const book390 = probe("book-390", {
    url: `${BASE}/?wk=1#/book`, w: 390, h: 844, shot: "book-390.png",
    js: wrap(`
      var card = document.querySelector('#services .svc');
      var other = document.querySelector('label[data-svc="standard"]') === card ? document.querySelector('#services .svc:not(.on)') : card;
      var panel = document.querySelector('.card');
      var cs = card ? getComputedStyle(card) : null;
      var os = other ? getComputedStyle(other) : null;
      var ps = panel ? getComputedStyle(panel) : null;
      out.services = document.querySelectorAll('#services .svc').length;
      out.svcRadius = cs ? cs.borderTopLeftRadius : null;
      out.svcSelectedBg = cs ? cs.backgroundColor : null;
      out.svcSelectedImage = cs ? cs.backgroundImage : null;
      out.svcPlainBg = os ? os.backgroundColor : null;
      out.svcSelectedRing = cs ? cs.borderColor : null;
      out.accentRgb = getComputedStyle(document.documentElement).getPropertyValue('--red-rgb').trim();
      out.panelRadius = ps ? ps.borderTopLeftRadius : null;
      out.panelShadow = ps ? (ps.boxShadow || 'none').slice(0, 24) : null;
      out.total = (document.querySelector('#t-total') || {}).textContent || '';
      out.leg = (document.querySelector('#leg-txt') || {}).textContent || '';
      var svg = document.querySelector('.legline svg, .route-strip svg');
      out.routeSvgWidth = svg ? Math.round(svg.getBoundingClientRect().width) : null;
      var win = document.querySelector('#pickupWindow');
      out.windowValue = win ? win.value : '';
      out.windowOptions = win ? win.options.length : 0;
      /* WebKit has to run the app, not just paint it: pick a tier, re-read the price */
      var before = out.total;
      var vip = document.querySelector('label[data-svc="sameday"]');
      if (vip) vip.click();
      deferred = true;
      setTimeout(function () {
        out.totalAfterVip = (document.querySelector('#t-total') || {}).textContent || '';
        out.viprepriced = out.totalAfterVip !== before;
        out.vipOn = !!document.querySelector('label[data-svc="sameday"].on');
        out.windowNote = (document.querySelector('#window-note') || {}).textContent || '';
        finish();
      }, 700);
    `),
  });
  check("WebKit really served the page (not Blink in disguise)", book390.webkit === true, book390);
  check("the view is painted, not parked at opacity 0 by its entry animation", book390.viewOpacity === "1" && book390.animsSeeked > 0, [book390.viewOpacity, book390.animsSeeked]);
  check("booking renders 3 tiers on WebKit", book390.services === 3, book390.services);
  check("booking fits 390px on WebKit", book390.scrollWidth <= book390.clientWidth + 1, [book390.scrollWidth, book390.clientWidth, book390.offenders]);
  check("nothing hangs off the right edge", book390.offenders.length === 0, book390.offenders);
  const alpha = (s) => String(s || "").startsWith("color(") ? Number(String(s).match(/\/\s*([\d.]+)/)?.[1] ?? 1) : String(s || "").startsWith("rgba(") ? Number(String(s).split(",")[3]) : 1;
  const plainAlpha = alpha(book390.svcPlainBg);
  check("the brand sheet applied: 10px tiers, 14px quote panel, translucent glass behind", book390.svcRadius === "10px" && book390.panelRadius === "14px" && plainAlpha > 0 && plainAlpha <= .82, [book390.svcRadius, book390.panelRadius, book390.svcPlainBg]);
  // Whatever the studio's accent is, the chosen tier must carry it — compare against
  // the injected --red-rgb token instead of a hard-coded shade that dates.
  const rgb = (s) => (String(s || "").match(/\d+/g) || []).slice(0, 3).map(Number).join(",");
  const accent = rgb(book390.accentRgb);
  const accentWash = new RegExp(`rgba?\\(\\s*${accent.split(",").join("\\s*,\\s*")}\\s*,`).test(book390.svcSelectedImage || "");
  check("the chosen tier is marked in the studio accent",
    accent !== "" && accentWash && rgb(book390.svcSelectedRing) === accent,
    [book390.accentRgb, book390.svcSelectedImage, book390.svcSelectedRing]);
  check("the quote panel keeps its shadow", /rgba|rgb/.test(book390.panelShadow || ""), book390.panelShadow);
  check("the live quote shows a cedi total", /^GH₵[0-9]/.test(book390.total), book390.total);
  check("a click on a tier reprices the quote in WebKit", book390.viprepriced === true && book390.vipOn === true, [book390.total, book390.totalAfterVip, book390.vipOn]);
  check("the route svg shrank to its column, not its 300px intrinsic width", book390.routeSvgWidth !== null && book390.routeSvgWidth <= 360, book390.routeSvgWidth);

  /* 2 — the narrow tail, where WebKit's min-content rules bite */
  const book320 = probe("book-320", {
    url: `${BASE}/?wk=2#/book`, w: 320, h: 568, shot: "book-320.png",
    js: wrap(`
      var sel = document.querySelector('#toId'), m = '';
      for (var i = 0; i < sel.options.length; i++) if (sel.options[i].text.length > m.length) m = sel.options[i].text;
      out.longestOption = m;
      out.selectWidth = Math.round(sel.getBoundingClientRect().width);
      out.selectScroll = sel.scrollWidth;
    `),
  });
  check("320px WebKit has no page overflow", book320.scrollWidth <= book320.clientWidth + 1, [book320.scrollWidth, book320.clientWidth, book320.offenders]);
  check("the destination select stays inside the screen", book320.selectWidth > 0 && book320.selectWidth <= 320, book320);

  /* 3 — the traveller's tracker, photo included */
  const track = probe("track-390", {
    url: `${BASE}/?wk=3#/track/${DEMO}`, w: 390, h: 844, settle: 2600, shot: "track-390.png",
    js: wrap(`
      var t = document.querySelector('.track-card');
      out.card = !!t;
      out.stages = document.querySelectorAll('.tl li').length;
      out.reached = document.querySelectorAll('.tl li.done, .tl li.now').length;
      out.now = (document.querySelector('.now-card .big') || {}).textContent || '';
      out.distance = (document.querySelector('.route-strip .muted') || {}).textContent || '';
      var img = document.querySelector('.gallery .shot img');
      out.photo = img ? { src: img.getAttribute('src'), w: img.naturalWidth } : null;
      out.photoMentions = ((t ? t.textContent : '').match(/photo/gi) || []).length;
      out.galleryLbl = (document.querySelector('.gallery .lbl') || {}).textContent || '';
      out.driver = /Kwesi/.test((document.querySelector('.now-card') || {}).textContent || '');
      out.text = t ? t.textContent.replace(/\\s+/g, ' ').slice(0, 900) : '';
    `),
  });
  check("the tracker renders the whole ladder on WebKit", track.card && track.stages >= 6, [track.card, track.stages]);
  check("reached stages are marked", track.reached >= 3, track.reached);
  check("the custody photo decodes in WebKit too", !!track.photo && track.photo.w > 0, track.photo);
  check("the only photo sentence on the tracker is the real gallery label", track.photoMentions === 1 && /Photographed at collection/.test(track.galleryLbl), [track.photoMentions, track.galleryLbl]);
  check("the leg distance is a number, not an em dash", /\d/.test(track.distance), track.distance);
  check("the driver card shows once the haul is out for delivery", track.driver === true && /Out for delivery/i.test(track.now), [track.now, track.driver]);
  check("the public tracker never prints the handover PIN", !track.text.includes(DEMO_PIN) && !/"?pinSeal"?/.test(track.text), track.text.slice(0, 80));

  /* 4 — the board before anyone says the passphrase */
  const locked = probe("dispatch-locked", {
    url: `${BASE}/?wk=4#/dispatch`, w: 1440, h: 900, shot: "dispatch-locked.png",
    js: wrap(`
      out.panel = !!document.querySelector('.lock-panel');
      out.rows = document.querySelectorAll('.row').length;
      out.stats = document.querySelectorAll('.stat').length;
      out.words = (document.querySelector('#board') || {}).textContent || '';
    `),
  });
  check("WebKit gets the same locked board", locked.panel === true && locked.rows === 0 && locked.stats === 0, locked);
  check("the locked board names nobody", !/Ama Boateng|Olive Drive|Kokomlemle/.test(locked.words), locked.words.slice(0, 70));

  /* 5 — and after the desk says it. The passphrase is written into
     sessionStorage at document start, exactly like a second visit in the shift. */  const board = probe("dispatch-board", {
    url: `${BASE}/?wk=5#/dispatch`, w: 1440, h: 900, token: TOKEN, settle: 2400, shot: "dispatch-board.png",
    js: wrap(`
      out.rows = document.querySelectorAll('.row').length;
      out.stats = document.querySelectorAll('.stat').length;
      out.statLabels = [].map.call(document.querySelectorAll('.stat span'), function (s) { return s.textContent; });
      out.unlocked = /Unlocked for this shift/.test((document.querySelector('#lockbar') || {}).textContent || '');
      deferred = true;
      var t = document.querySelector('.row [data-act="toggle"]');
      if (t) t.click();
      setTimeout(function () {
        var d = document.querySelector('.row.open .row-detail');
        var img = document.querySelector('.row .shot img');
        out.detailOpen = !!d;
        out.detailText = d ? d.textContent.replace(/\\s+/g, ' ') : '';
        out.pinShown = new RegExp('Handover PIN\\s*' + ${JSON.stringify(DEMO_PIN)}).test(out.detailText);
        out.noSealedBlob = !/aes256gcm|pinSeal/.test(out.detailText);
        out.shots = document.querySelectorAll('.row .shot img').length;
        out.shotDecoded = !!img && img.naturalWidth > 0;
        out.canShoot = !!document.querySelector('.row input[data-photo]');
        out.fullPhone = /\\+233 53 558 3460/.test(document.querySelector('.row').textContent);
        finish();
      }, 800);
    `),
  });
  check("the passphrase unlocks the board on WebKit", board.unlocked === true && board.rows >= 1, board);
  check("seven stat tiles, photos included", board.stats === 7 && /Custody photos/.test(board.statLabels.join("|")), [board.stats, board.statLabels]);
  check("row details open and read the handover PIN aloud for the desk", board.detailOpen === true && board.pinShown === true, [board.detailOpen, board.pinShown]);
  check("the desk never sees a sealed blob", board.noSealedBlob === true, board.detailText.slice(0, 60));
  check("dispatch keeps the full phone number the traveller never sees", board.fullPhone === true, board.fullPhone);
  check("the custody photo renders on the board", board.shots >= 1 && board.shotDecoded === true, board);
  check("the collector's camera button is there", board.canShoot === true, board.canShoot);

  /* 6 — the phone-sized board: the restacked row and the swiping filter */
  const phone = probe("dispatch-320", {
    url: `${BASE}/?wk=6#/dispatch`, w: 320, h: 568, token: TOKEN, settle: 2400, shot: "dispatch-320.png",
    js: wrap(`
      out.rows = document.querySelectorAll('.row').length;
      deferred = true;
      var t = document.querySelector('.row [data-act="toggle"]');
      if (t) t.click();
      setTimeout(function () {
        var seg = document.querySelector('#status-filter');
        var a = document.querySelector('.row .acts');
        out.segOverflowX = seg ? getComputedStyle(seg).overflowX : null;
        out.segFits = seg ? Math.round(seg.getBoundingClientRect().right) <= document.documentElement.clientWidth + 1 : null;
        out.actsStacked = a ? getComputedStyle(a).flexWrap : null;
        finish();
      }, 500);
    `),
  });
  check("the manifest fits 320px on WebKit", phone.scrollWidth <= phone.clientWidth + 1, [phone.scrollWidth, phone.clientWidth, phone.offenders]);
  check("the status filter swipes instead of pushing the page wide", phone.segOverflowX === "auto" && phone.segFits === true, phone);

  /* 7 — install UX as an iPhone sees it. WebKit has no beforeinstallprompt, so
     the button must open the Share-sheet recipe; a dead button would leave an
     iPhone user with no way to add the app. */
  const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
  const install = probe("install-390", {
    url: `${BASE}/?wk=7#/book`, w: 390, h: 844, ua: IPHONE_UA, settle: 2400, shot: "install-390.png",
    js: wrap(`
      out.iosUa = /iPhone/.test(navigator.userAgent);
      out.standalone = matchMedia('(display-mode: standalone)').matches;
      out.appleCapable = (document.querySelector('meta[name="apple-mobile-web-app-capable"]') || {}).content || null;
      out.appleTitle = (document.querySelector('meta[name="apple-mobile-web-app-title"]') || {}).content || null;
      out.appleIcon = (document.querySelector('link[rel="apple-touch-icon"]') || {}).getAttribute('href') || null;
      out.manifest = (document.querySelector('link[rel="manifest"]') || {}).getAttribute('href') || null;
      var btn = document.getElementById('install-app');
      out.btnExists = !!btn;
      out.btnHiddenAtRest = btn ? btn.hidden : null;
      deferred = true;
      var tries = 0;
      var timer = setInterval(function () {
        var b = document.getElementById('install-app');
        if (b && !b.hidden) {
          clearInterval(timer);
          b.click();
          setTimeout(function () {
            var s = document.getElementById('install-sheet');
            out.sheetOpen = !!(s && !s.hidden);
            out.steps = [].map.call(document.querySelectorAll('#install-steps li'), function (li) { return li.textContent; });
            out.lead = (document.getElementById('install-lead') || {}).textContent || '';
            out.aria = b.getAttribute('aria-expanded');
            document.getElementById('install-close').click();
            out.closed = !!(s && s.hidden);
            finish();
          }, 300);
        } else if (++tries > 40) {
          clearInterval(timer);
          out.fail = 'install button never appeared';
          finish();
        }
      }, 100);
    `),
  });
  check("on an iPhone-sized WebKit the install button is offered", install.btnExists === true && install.btnHiddenAtRest === false, install);
  check("the button opens the Add to Home Screen recipe, not a dead click", install.sheetOpen === true && install.steps.length === 3, install);
  check("the recipe is the iOS one: Share, then Add to Home Screen", /Share/.test(install.steps[0] || "") && /Add to Home Screen/.test(install.steps[1] || ""), install.steps);
  check("the sheet says what installing buys, and closes again", /home screen/i.test(install.lead) && install.closed === true && install.aria === "true", install);
  check("iOS head tags are the ones Safari reads", install.appleCapable === "yes" && install.appleTitle === "BrownHub Haul" && /apple-touch-icon\.png$/.test(install.appleIcon || ""), install);
  check("the manifest is linked for the Android half of the app", install.manifest === "site.webmanifest", install.manifest);
  check("the install pill fits an iPhone 390", install.scrollWidth <= install.clientWidth + 1 && install.offenders.length === 0, [install.scrollWidth, install.clientWidth, install.offenders]);

  /* 8 — Chrome on iPhone is WebKit too, but only Safari can add to the home
     screen. The sheet must say so instead of walking the user into a dead end. */
  const CRIOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1";
  const crios = probe("install-crios-390", {
    url: `${BASE}/?wk=8#/book`, w: 390, h: 844, ua: CRIOS_UA, settle: 2200,
    js: wrap(`
      deferred = true;
      var tries = 0;
      var timer = setInterval(function () {
        var b = document.getElementById('install-app');
        if (b && !b.hidden) {
          clearInterval(timer);
          b.click();
          setTimeout(function () {
            var s = document.getElementById('install-sheet');
            out.sheetOpen = !!(s && !s.hidden);
            out.lead = (document.getElementById('install-lead') || {}).textContent || '';
            finish();
          }, 250);
        } else if (++tries > 40) { clearInterval(timer); out.fail = 'button never appeared'; finish(); }
      }, 100);
    `),
  });
  check("Chrome on iPhone still gets the sheet", crios.sheetOpen === true, crios);
  check("Chrome on iPhone is told to open Safari first, not to hunt for a menu item", /Safari first/i.test(crios.lead), crios.lead);

  console.log(`\ntypeface on WebKit: Poppins + ₵ ${book390.poppinsCedi ? "resolved" : "NOT resolved"}`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} WebKit assertions passed`);
  console.log(`shots: ${SHOTS}`);
  writeFileSync(join(OUT, "webkit-results.json"), JSON.stringify({ passed: results.length - failed.length, total: results.length, results }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error("!! webkit probe failed: " + (e?.message || e));
  process.exitCode = 1;
} finally {
  if (server?.pid) { try { process.kill(-server.pid, "SIGKILL"); } catch { try { server.kill("SIGKILL"); } catch { /* gone */ } } }
  await sleep(300);
  rmSync(DB, { force: true });
  rmSync(PHOTOS, { recursive: true, force: true });
  try { await bindPorts([APP]); console.log("teardown clean · port free"); }
  catch (e) { console.log("!! port still busy — " + e.message); }
}
