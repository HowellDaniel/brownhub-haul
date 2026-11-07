/**
 * API smoke test. Run with the server up:
 *   HAUL_TOKEN='the depot passphrase' node tools/smoke.mjs [baseURL]
 *
 * Everything the depot owns — the manifest, status changes, custody photos —
 * is 401 without that token, so run this WITH it or half the suite reports the
 * truth (locked) as a failure. Public routes stay token-free on purpose.
 *
 * Asserts the contracts the UI depends on; exits non-zero on the first failure.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8420";
const TOKEN = process.env.HAUL_TOKEN || "";
let pass = 0;
const fails = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fails.push(name);
    console.log(`  FAIL ${name}${detail ? ` → ${JSON.stringify(detail)}` : ""}`);
  }
}

const get = async (p, opts) => {
  const r = await fetch(BASE + p, opts);
  let body = null;
  const text = await r.text();
  try { body = JSON.parse(text); } catch { body = { _raw: text } }
  return { status: r.status, body, text, headers: r.headers };
};
const post = (p, obj) => get(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
const patch = (p, obj) => get(p, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

/** The same three calls, wearing the depot's badge. */
const AUTH = { "content-type": "application/json", ...(TOKEN ? { "x-haul-token": TOKEN } : {}) };
const getA = (p) => get(p, { headers: { "x-haul-token": TOKEN } });
const postA = (p, obj) => get(p, { method: "POST", headers: AUTH, body: JSON.stringify(obj) });
const patchA = (p, obj) => get(p, { method: "PATCH", headers: AUTH, body: JSON.stringify(obj) });

/** A real image, from the repo's own assets — the server sniffs magic bytes,
 *  so a hand-written base64 string would test the wrong thing. */
const fixtureImage = () => {
  const png = readFileSync(join(HERE, "..", "assets", "logo.png"));
  return { data: `data:image/png;base64,${png.toString("base64")}`, bytes: png.length };
};

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  console.log(`BrownHub Haul API smoke @ ${BASE}\n`);

  const health = await get("/api/health");
  check("health 200", health.status === 200 && health.body.ok);
  check("health reports an anonymous visitor as public", health.body?.dispatch === false, health.body);
  const healthAuthed = await getA("/api/health");
  check("the depot token authenticates the holder", healthAuthed.body?.dispatch === true, healthAuthed.body);
  if (!TOKEN) console.log("  NOTE HAUL_TOKEN is unset — the dispatch-only checks below will report the board as locked.");

  const gateList = await get("/api/shipments");
  check("manifest refused without the token", gateList.status === 401 && /passphrase/i.test(gateList.body?.message || ""), { status: gateList.status, message: gateList.body?.message });
  check("a refusal is a sentence, not a bare status", typeof gateList.body?.message === "string" && gateList.body.message.length > 20, gateList.body);
  check("the 401 never lists what it is hiding", !/Ama Boateng|Kokomlemle/.test(gateList.text), gateList.text.slice(0, 120));

  const cfg = await get("/api/config");
  check("config carries contacts", cfg.body?.contact?.whatsapp === "233535583460", cfg.body?.contact);
  check("config has 3 services", cfg.body?.services?.length === 3);
  // the card copy is generated from handlingHours; if it ever drifts the traveller is
  // shown one promise on the tier card and another in the quote line.
  const promised = (s) => (s.handlingHours >= 2 ? `within ${s.handlingHours} working hours` : `within ${s.handlingHours * 60} minutes`);
  const drift = (cfg.body?.services || []).filter((s) => !s.blurb.includes(promised(s)));
  check("service copy states the SLA the engine quotes", drift.length === 0, drift.map((s) => [s.id, s.handlingHours, s.blurb]));
  check("statuses are ordered", cfg.body?.statuses?.[0]?.key === "booked" && cfg.body?.statuses?.at(-1)?.key === "delivered");

  const places = await get("/api/places");
  check("places split origins/destinations", places.body?.origins?.length > 5 && places.body?.destinations?.length > 5);
  const bad = await get("/api/quote?fromId=kokomlemle&toId=kokomlemle&weightKg=10&pieces=1");
  check("same-place quote rejected 422", bad.status === 422 && bad.body.errors.some((e) => e.field === "toId"), bad.body);

  const q = await get("/api/quote?fromId=kokomlemle&toId=kotoka&weightKg=18&pieces=2&service=express&insurance=true&declaredValue=4500");
  check("quote 200", q.status === 200 && q.body.ok);
  check("quote has vat line", Math.abs(q.body.vat / q.body.net - 0.15) < 0.001, { vat: q.body.vat, net: q.body.net });
  const sStd = await get("/api/quote?fromId=kokomlemle&toId=kotoka&weightKg=18&pieces=2&service=standard");
  const sVip = await get("/api/quote?fromId=kokomlemle&toId=kotoka&weightKg=18&pieces=2&service=sameday");
  check("express costs more than standard", q.body.total > sStd.body.total, [sStd.body.total, q.body.total]);
  check("same-day costs more than express", sVip.body.total > (await get("/api/quote?fromId=kokomlemle&toId=kotoka&weightKg=18&pieces=2&service=express")).body.total, [q.body.total, sVip.body.total]);
  const noIns = await get("/api/quote?fromId=kokomlemle&toId=kotoka&weightKg=18&pieces=2&service=standard");
  const withIns = await get("/api/quote?fromId=kokomlemle&toId=kotoka&weightKg=18&pieces=2&service=sameday&insurance=true&declaredValue=9000");
  const insLine = withIns.body.lines.find((l) => l.key === "insurance");
  check("insurance is priced, not multiplied", insLine.amount === 270, insLine);
  // query strings are TEXT: "false" is truthy, so a GET that switches an option off
  // must not price it in. oversize used to be missing from the coercion list.
  const offKeys = (r) => r.body.lines.map((l) => l.key).join(",");
  const flagsOff = await get("/api/quote?fromId=kokomlemle&toId=kotoka&weightKg=5&pieces=1&oversize=false&fragile=false&insurance=false");
  const bare = await get("/api/quote?fromId=kokomlemle&toId=kotoka&weightKg=5&pieces=1");
  check("GET quote: =false really means off", !/oversize|fragile|insurance/.test(offKeys(flagsOff)), offKeys(flagsOff));
  check("flags-off equals a bare quote", flagsOff.body.total === bare.body.total, { off: flagsOff.body.total, bare: bare.body.total });
  const flagsOn = await post("/api/quote", { fromId: "kokomlemle", toId: "kotoka", weightKg: 5, pieces: 1, oversize: true, fragile: true });
  check("POST quote prices the same options on", /oversize/.test(offKeys(flagsOn)) && flagsOn.body.total > flagsOff.body.total, offKeys(flagsOn));
  const minQ = await get("/api/quote?fromId=osu&toId=cantonments&weightKg=1&pieces=1&service=standard");
  check("minimum charge enforced", minQ.body.total >= 65, minQ.body.total);
  const promoQ = await get("/api/quote?fromId=kokomlemle&toId=kotoka&weightKg=18&pieces=2&promo=BHHAUL10");
  check("promo discounts and is capped", promoQ.body.discount > 0 && promoQ.body.discount <= 100, promoQ.body.discount);
  const badPromo = await get("/api/quote?fromId=kokomlemle&toId=kotoka&weightKg=18&promo=NOPE");
  check("unknown promo 422", badPromo.status === 422, badPromo.body);
  const wkndQ = await get(`/api/quote?fromId=kokomlemle&toId=kotoka&weightKg=18&pickupDate=${day(weekendAhead())}`);
  check("weekend pickup surcharges", wkndQ.body.lines.some((l) => l.key === "weekend"), wkndQ.body.lines.map((l) => l.key));

  const book = await post("/api/shipments", {
    fromId: "east-legon", toId: "kmasoku", pieces: 3, weightKg: 38, service: "sameday",
    insurance: true, declaredValue: 9000, fragile: true, pickupDate: day(1), pickupWindow: "08:00 – 10:00",
    customerName: "Kojo Mensah", customerPhone: "+233 55 111 2222", customerEmail: "kojo.should-not-leak@example.com",
    address: "Flat 2, Adjeitey St",
    reference: "hotel check-in 18:00", notes: "call on arrival", promo: "BHHAUL10",
  });
  const code = book.body?.code;
  const pin = String(book.body?.pin || "");
  check("booking 201 + code shape", book.status === 201 && /^BH-[A-Z2-9]{6}$/.test(code || ""), { status: book.status, code });
  check("booking issues a 4-digit PIN", /^\d{4}$/.test(pin), { shape: /^\d{4}$/.test(pin) });
  check("booking starts at booked", book.body?.status === "booked");
  check("server re-quoted on write", typeof book.body?.total === "number" && book.body.total > 0);
  check("address + reference persisted", book.body?.address === "Flat 2, Adjeitey St" && book.body?.reference === "hotel check-in 18:00");
  // the booking response is the ONE place the plain PIN appears; the traveller must get it.
  check("no sealed blob on the way out", !JSON.stringify(book.body).includes("aes256gcm:"), Object.keys(book.body));

  const reject = await post("/api/shipments", { fromId: "osu", toId: "osu", pieces: 1, weightKg: 10, pickupDate: day(1), pickupWindow: "08:00 – 10:00", customerName: "A", customerPhone: "123" });
  check("invalid booking rejected", reject.status === 400 && reject.body.errors.length >= 2, reject.body);
  const noPhone = await post("/api/shipments", { fromId: "osu", toId: "kotoka", pieces: 1, weightKg: 10, pickupDate: day(1), pickupWindow: "08:00 – 10:00", customerName: "Abena", customerPhone: "123" });
  check("short phone rejected", noPhone.status === 400 && noPhone.body.errors.some((e) => e.field === "customerPhone"), noPhone.body);

  const one = await get(`/api/shipments/${code}`);
  check("read back by code", one.status === 200 && one.body.code === code);
  check("tracking ships the status ladder", one.body.statuses?.length === 6);
  const lower = await get(`/api/shipments/${String(code).toLowerCase()}`);
  check("code lookup is case-insensitive", lower.status === 200, lower.status);
  const bogus = await get("/api/shipments/BH-@@@@");
  check("malformed code → 400", bogus.status === 400, bogus.status);
  const missing = await get("/api/shipments/BH-ZZZZZZ");
  check("unknown code → 404", missing.status === 404, missing.status);

  /* A tracking code is a capability: anyone who is sent the link can read this
     route. Everything the traveller did not already type in themselves stays off. */
  check("public read carries no PIN", !one.text.includes(pin), { hasPin: one.text.includes(pin) });
  check("public read carries no sealed PIN", !/pinSeal|aes256gcm:/.test(one.text), one.text.slice(0, 80));
  check("public read masks the phone", /\u2022\u2022\u2022/.test(one.text) && !one.text.includes("55 111 2222"), one.text.match(/"phone":"[^"]*"/)?.[0]);
  check("public read drops the e-mail", !one.text.includes("example.com"), one.text.match(/"email":?[^,]*/g)?.slice(0, 2));
  check("public read still tells the traveller the haul", one.body.customer?.name === "Kojo Mensah" && one.body.logistics?.pieces === 3, one.body.customer);
  check("the tracker's own stage notes survive", Array.isArray(one.body.history) && one.body.history.length >= 1);
  check("public read says nothing about PINs", !/"pin"\s*:/.test(one.text), one.text.match(/"pin"[^,]*/)?.[0]);

  const authed = await getA(`/api/shipments/${code}`);
  check("dispatch read unseals the PIN for the desk", authed.body?.pin === pin, { got: typeof authed.body?.pin });
  check("dispatch read keeps the full phone", authed.body?.customer?.phone === "+233 55 111 2222", authed.body?.customer?.phone);
  check("dispatch read never leaks the sealed blob", !/pinSeal|aes256gcm:/.test(authed.text), Object.keys(authed.body));
  const wrongToken = await get("/api/shipments/" + code, { headers: { "x-haul-token": TOKEN ? TOKEN + "x" : "BHDEPOT-NOPE-NOPE-NOPE-NOPE" } });
  check("a near-miss token gets the public view, not the PIN", !wrongToken.text.includes(pin), wrongToken.status);

  const a1 = await patchA(`/api/shipments/${code}`, { note: "sealed at the door" });
  check("advance → collected", a1.body?.shipment?.status === "collected", a1.body);
  const anonAdvance = await patch(`/api/shipments/${code}`, { note: "anyone can write" });
  check("advance refused without the token", anonAdvance.status === 401, anonAdvance.status);
  const a2 = await patchA(`/api/shipments/${code}`, { status: "out_for_delivery" });
  check("jump to out_for_delivery assigns a driver", a2.body?.shipment?.status === "out_for_delivery" && !!a2.body?.shipment?.driver, a2.body?.shipment?.driver);
  const a3 = await patchA(`/api/shipments/${code}`, { status: "delivered" });
  check("delivered is terminal", a3.body?.shipment?.status === "delivered");
  const a4 = await patchA(`/api/shipments/${code}`, {});
  check("advancing past delivered fails cleanly", a4.status === 400, a4.body);

  const pinBad = await patch(`/api/shipments/${code}`, { action: "verify-pin", pin: "0000" });
  check("wrong PIN refused", pinBad.status === 422 && pinBad.body.ok === false);
  check("a refusal returns no record", !/"logistics"|"address"|"history"/.test(pinBad.text), pinBad.text.slice(0, 90));
  const pinGood = await patch(`/api/shipments/${code}`, { action: "verify-pin", pin });
  check("right PIN accepted", pinGood.status === 200 && pinGood.body.ok === true);
  check("the answer is a name and a sentence", pinGood.body.ok === true && pinGood.body.name === "Kojo Mensah" && /Handover accepted/.test(pinGood.body.message), Object.keys(pinGood.body));
  check("acceptance does not hand back the PIN", !pinGood.text.includes(pin) && !pinGood.text.includes("pinSeal"), pinGood.text.slice(0, 90));

  const late = await patchA(`/api/shipments/${code}`, { action: "exception", note: "Traffic on the N1" });
  check("delay flagged", late.body?.shipment?.status === "delayed" && late.body.shipment.history.at(-1).note === "Traffic on the N1");
  const resumed = await patchA(`/api/shipments/${code}`, { note: "back on" });
  check("delay resumes to a real stage", !["delayed", "delivered"].includes(resumed.body?.shipment?.status), resumed.body?.shipment?.status);

  const list = await getA("/api/shipments");
  check("manifest opens with the token", list.status === 200 && Array.isArray(list.body?.shipments), list.status);
  check("list has stats", typeof list.body?.stats?.pipelineValue === "number" && list.body.stats.total >= 2, list.body?.stats);
  const filter = await getA("/api/shipments?status=delivered");
  check("status filter works", filter.body.shipments.every((s) => s.status === "delivered"), filter.body.shipments.map((s) => s.status));
  const search = await getA("/api/shipments?q=kojo");
  check("text search works", search.body.shipments.length === 1 && search.body.shipments[0].code === code, search.body.shipments?.length);

  /* ————————————————————————— custody photos ————————————————————————— */
  const shot = fixtureImage();
  const anonPhoto = await post(`/api/shipments/${code}/photos`, { data: shot.data });
  check("photo upload refused without the token", anonPhoto.status === 401, anonPhoto.status);
  const junkPhoto = await postA(`/api/shipments/${code}/photos`, { data: "data:image/png;base64,not-an-image-at-all" });
  check("junk bytes are refused", junkPhoto.status === 422 && /image|camera|JPEG/i.test(junkPhoto.body.message || ""), junkPhoto.body);
  const hugePhoto = await postA(`/api/shipments/${code}/photos`, { data: `data:image/png;base64,${"A".repeat(4.6 * 1024 * 1024)}` });
  check("a photo over the 3 MB decode cap is refused", hugePhoto.status === 422 && /too large/i.test(hugePhoto.body.message || ""), { status: hugePhoto.status, message: hugePhoto.body.message });
  const photo = await postA(`/api/shipments/${code}/photos`, { data: shot.data, note: "two cases sealed at the door" });
  const photoUrl = photo.body?.photo?.url;
  // The URL is mount-relative on purpose: the app runs at / and at /haul/ alike.
  check("photo stored", photo.status === 201 && /^photos\/BH-[A-Z2-9]{6}\/[\w.-]+\.(png|jpg)$/.test(photoUrl || ""), { status: photo.status, photoUrl });
  check("photo is on the haul and in the history", photo.body?.shipment?.photos?.length >= 1 && /Custody photo/.test(JSON.stringify(photo.body.shipment.history)), photo.body?.shipment?.history?.at(-1));
  if (photoUrl) {
    const served = await get("/" + photoUrl);
    check("photo serves back as an image", served.status === 200 && /^image\/(png|jpeg)/.test(served.headers.get("content-type") || ""), served.headers.get("content-type"));
    check("photo refuses to be cached or framed", /no-store/.test(served.headers.get("cache-control") || "") && /same-origin/.test(served.headers.get("cross-origin-resource-policy") || ""), Object.fromEntries([...served.headers].slice(0, 8)));
    const servedAuthed = await getA(`/api/shipments/${code}`);
    check("dispatch sees the photo path", JSON.stringify(servedAuthed.body.photos || []).includes(photoUrl), servedAuthed.body.photos);
    const servedPublic = await get(`/api/shipments/${code}`);
    check("the tracker sees the photo path too (it is the traveller's own bag)", JSON.stringify(servedPublic.body.photos || []).includes(photoUrl), servedPublic.body.photos);
  }
  const trav = await get(`/photos/${code}/%2e%2e%2f%2e%2e%2fserver.mjs`);
  check("encoded photo traversal refuses to read outside the folder", trav.status === 404, { status: trav.status, head: trav.text.slice(0, 40) });
  const dbl = await get(`/photos/${code}/%252e%252e%252fserver.mjs`);
  check("double-encoded traversal refuses too", dbl.status === 404, dbl.status);
  const rawDot = await get(`/photos/${code}/../../../server.mjs`);
  check("a normalised dot-dot path is not served", rawDot.status === 404 && !rawDot.text.includes("createServer"), { status: rawDot.status });

  const missingPhoto = await get(`/photos/${code}/nope.jpg`);
  check("an unknown photo is a 404, not a directory listing", missingPhoto.status === 404, missingPhoto.status);
  const badCodePhoto = await postA("/api/shipments/BH-ZZZZZZ/photos", { data: shot.data });
  check("a photo for an unknown haul is refused", badCodePhoto.status === 404, badCodePhoto.status);

  const serverSrc = await fetch(BASE + "/server.mjs");
  check("server source is not served", serverSrc.status === 404, serverSrc.status);
  const encoded = await fetch(BASE + "/%2e%2e%2f%2e%2e%2fetc%2fhosts");
  check("encoded traversal is refused", encoded.status !== 200 || !(await encoded.text()).includes("root:"), encoded.status);
  const inside = await fetch(BASE + "/core/../server.mjs");
  check("inline traversal is refused", inside.status !== 200, inside.status);
  const dbFile = await fetch(BASE + "/data/shipments.json");
  check("data directory not served", dbFile.status === 404 || dbFile.status === 403, dbFile.status);
  const tools = await fetch(BASE + "/tools/smoke.mjs");
  check("tools directory not served", tools.status === 404, tools.status);
  const css = await fetch(BASE + "/styles/app.css");
  check("public assets still serve", css.status === 200 && (await css.text()).includes("--red"), css.status);
  const spa = await fetch(BASE + "/dispatch");
  check("SPA fallback serves the shell", spa.status === 200 && (await spa.text()).includes("BrownHub Haul"));

  /* ————— the manifest on disk, if we are pointed at one we can read ————— */
  if (process.env.DB) {
    try {
      const disk = readFileSync(process.env.DB, "utf8");
      check("the manifest file holds no plain-text PIN", !/"pin"\s*:/.test(disk) && !disk.includes(pin), { quotes: (disk.match(/"pin"/g) || []).length });
      check("the manifest file holds no depot token", !disk.includes(TOKEN) && !/"token"\s*:/.test(disk), { hasTokenField: /"token"/.test(disk) });
      check("the depot token is kept only as an HMAC", /"tokenMac"/.test(disk), disk.match(/"meta":[^}]*}/)?.[0]);
      check("sealed PINs are sealed", /aes256gcm:/.test(disk), disk.match(/"pinSeal"/)?.[0]);
    } catch (e) {
      check("the manifest file is readable for the audit", false, e.message);
    }
  } else {
    console.log("  NOTE DB is unset — skipped the on-disk manifest audit.");
  }

  /* —————————————— PIN guessing is the slowest door ——————————————
     Deliberately LAST: the throttle is keyed on code+ip and this code stays
     locked for the rest of the ten-minute window. */
  let throttled = null;
  for (let i = 0; i < 12 && !throttled; i++) {
    const r = await patch(`/api/shipments/${code}`, { action: "verify-pin", pin: "0000" });
    if (r.status === 429) throttled = r;
  }
  check("repeated PIN guessing is throttled", !!throttled, { last: throttled?.status });
  check("the throttle explains itself", /wait ten minutes/i.test(throttled?.body?.message || ""), throttled?.body);
  const blockedAdvance = await patch(`/api/shipments/${code}`, { action: "verify-pin", pin });
  check("a blocked code cannot be checked past the wall", blockedAdvance.status === 429, blockedAdvance.status);

  console.log(`\n${pass} passed, ${fails.length} failed${fails.length ? `: ${fails.join(", ")}` : ""}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error("harness blew up:", e);
  process.exit(2);
});

/** First Saturday/Sunday strictly after today — the weekend rule needs a real weekend date. */
function weekendAhead() {
  const d = new Date();
  do d.setDate(d.getDate() + 1);
  while (d.getDay() !== 0 && d.getDay() !== 6);
  return Math.round((d - new Date()) / 86400000);
}
