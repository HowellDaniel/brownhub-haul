#!/usr/bin/env node
/**
 * BrownHub Haul — API + static host.
 *
 * Zero dependencies on purpose: the depot laptop that runs this has nothing
 * installed and no build step. Node 20+ only.
 *
 *   node server.mjs                 → http://127.0.0.1:8420
 *   PORT=9000 DB=/tmp/x.json node server.mjs
 *   HAUL_TOKEN=BHDEPOT-…            set the dispatch passphrase (else it is
 *                                   generated and printed once on first boot)
 *
 * WHO CAN DO WHAT
 *   public    quote, book, track one haul by code, check a handover PIN
 *   token     the whole manifest, every status change, custody photos
 *   A tracking code is a capability, so the public view of a haul is redacted:
 *   no PIN, no e-mail, masked phone. See core/store.mjs publicView().
 */

import { createServer } from "node:http";
import { isIP } from "node:net";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, STATUSES, EXCEPTION_STATUS, isValidCode } from "./core/store.mjs";
import { quote, CONFIG, SERVICES, formatGHS } from "./core/pricing.mjs";
import { PLACES, ORIGINS, DESTINATIONS } from "./core/zones.mjs";
import { syncBrand, contactForHaul, brandStyleTag, DEFAULT_SITE, FALLBACK } from "./core/brand.mjs";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT || 8420);
const HOST = process.env.HOST || "127.0.0.1";
const DB = process.env.DB || join(ROOT, "data", "shipments.json");
const PHOTO_DIR = process.env.PHOTOS || join(dirname(DB), "photos");
const MAX_BODY = 64 * 1024; // every JSON call
const MAX_PHOTO = 6 * 1024 * 1024; // a base64 JPEG needs its own, larger cap
const MAX_IMAGE = 3 * 1024 * 1024; // once decoded

const store = new Store(DB);

/** Photos are written beside the manifest unless PHOTOS says otherwise. */
mkdir(PHOTO_DIR, { recursive: true }).catch(() => {});

/* Haul is an app of BrownHub Studio, so the studio's identity — name, palette,
 * address, phone — is read from the studio's own site at boot and cached beside
 * the manifest. The sync is a promise, not a blocking call: the port opens at
 * once, and the routes that need the brand await it. It never rejects; a dead
 * site ends in the cache or the bundled last-known values. */
const SITE = process.env.BROWN_SITE || DEFAULT_SITE;
const BRAND_CACHE = process.env.BRAND_CACHE || join(dirname(DB), "brand.json");
const BRAND_SYNC = syncBrand({
  site: SITE,
  cache: BRAND_CACHE,
  offline: process.env.BROWN_OFFLINE === "1" || SITE === "off",
  log: (line) => console.log(line),
});
BRAND_SYNC.then((st) => {
  console.log(`[brand] ${st.brand.parent.name} · ${st.brand.studio.address} · accent ${st.brand.tokens.accent} · source: ${st.source}`);
});

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function send(res, code, body, headers = {}) {
  const buf = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(buf);
}

const badRequest = (res, message, errors) => send(res, 400, { ok: false, error: message, errors: errors || [] });
const notFound = (res, what) => send(res, 404, { ok: false, error: `${what} not found` });
const unauthorized = (res) =>
  send(res, 401, {
    ok: false,
    error: "depot token required",
    message: "This is dispatch-only. Enter the depot passphrase to unlock the board.",
  });

function readBody(req, max = MAX_BODY) {
  return new Promise((resolve_, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error(`payload too large (limit ${Math.round(max / 1024)} KB)`), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve_({});
      try {
        resolve_(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(Object.assign(new Error("body is not valid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/* ————————————————————————— depot token ————————————————————————— */

function bearer(req) {
  const h = req.headers["x-haul-token"] || req.headers.authorization || "";
  return String(h).replace(/^Bearer\s+/i, "").trim();
}

const isDispatch = (req) => store.checkToken(bearer(req));

/* ————————————————————————— PIN throttle ————————————————————————— */

/** A four-digit PIN has 10,000 combinations, so the handover check has to be the
 *  slowest door on the app. Per code+ip, windowed; in memory on purpose — a
 *  restart clearing it is fine, an attacker restarting the depot laptop is not. */
const PIN_WINDOW_MS = 10 * 60 * 1000;
const PIN_MAX = 8;
const attempts = new Map();

/** The depot laptop is behind a Cloudflare tunnel or nginx, so every request
 *  arrives from 127.0.0.1. Keying the throttle on that would give the whole
 *  internet one bucket per code — one attacker could lock the driver out. When
 *  (and only when) the peer is loopback, take the proxy's forwarded client,
 *  validated as a real IP; a directly connected peer is used as-is. A platform
 *  proxy with a non-loopback peer (Render, Fly) needs TRUST_PROXY=1 — never set
 *  that on a server the internet can reach directly. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
function clientIp(req) {
  const peer = req.socket.remoteAddress || "?";
  if (!TRUST_PROXY && !LOOPBACK.has(peer)) return peer;
  const cf = String(req.headers["cf-connecting-ip"] || "").trim();
  if (isIP(cf)) return cf;
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return isIP(xff) ? xff : peer;
}

function pinAllowed(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > PIN_WINDOW_MS) {
    attempts.set(key, { n: 1, first: now });
    return true;
  }
  rec.n += 1;
  return rec.n <= PIN_MAX;
}

/* The booking form is public, and the manifest is the depot's only record of a
 *  bag. A per-client cap keeps a script from filling it with junk; the depot
 *  (holding the token) is never blocked, and twenty hauls in ten minutes is
 *  more than a household or a hotel front desk ever books. */
const BOOK_MAX = 20;
const bookAttempts = new Map();
function bookAllowed(ip) {
  const now = Date.now();
  const rec = bookAttempts.get(ip);
  if (!rec || now - rec.first > PIN_WINDOW_MS) {
    bookAttempts.set(ip, { n: 1, first: now });
    return true;
  }
  rec.n += 1;
  return rec.n <= BOOK_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (now - v.first > PIN_WINDOW_MS) attempts.delete(k);
}, PIN_WINDOW_MS).unref();

/* ————————————————————————— photos ————————————————————————— */

const MAGIC = [
  [ [0xff, 0xd8, 0xff], ".jpg" ],            // JPEG
  [ [0x89, 0x50, 0x4e, 0x47], ".png" ],      // PNG
];

function sniff(buf) {
  for (const [bytes, ext] of MAGIC) if (bytes.every((b, i) => buf[i] === b)) return ext;
  return null;
}

/** Accepts a data: URL or raw base64 of a JPEG/PNG the collector's phone took. */
async function savePhoto(code, dataUrl, note, by) {
  const b64 = String(dataUrl || "").replace(/^data:image\/[a-z]+;base64,/i, "");
  if (!b64 || b64.length > MAX_PHOTO) return { ok: false, message: "Photo is missing or too large (max 3 MB)." };
  let buf;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return { ok: false, message: "That was not a readable image." };
  }
  if (!buf.length || buf.length > MAX_IMAGE) return { ok: false, message: "Photo is too large (max 3 MB)." };
  const ext = sniff(buf);
  if (!ext) return { ok: false, message: "Only a JPEG or PNG from the collector's camera is accepted." };
  const file = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  await mkdir(join(PHOTO_DIR, code), { recursive: true });
  await writeFile(join(PHOTO_DIR, code, file), buf);
  return store.addPhoto(code, { file, note, by, size: buf.length });
}

const PHOTO_FILE = /^[A-Z2-9]{6}$/; // the code part, after BH-
const PHOTO_NAME = /^[\w.-]{1,80}\.(jpg|png)$/;

async function servePhoto(res, pathname) {
  const m = pathname.match(/^\/photos\/(BH-[A-Z2-9]{6})\/([\w.-]{1,80})$/);
  if (!m) return send(res, 404, "not found");
  const [, code, name] = m;
  if (!PHOTO_FILE.test(code.slice(3)) || !PHOTO_NAME.test(name) || basename(name) !== name) return send(res, 404, "not found");
  const abs = normalize(join(PHOTO_DIR, code, name));
  if (abs !== join(PHOTO_DIR, code, name)) return send(res, 404, "not found"); // no traversal, however dressed up
  try {
    const info = await stat(abs);
    if (info.isDirectory()) throw new Error("dir");
    const body = await readFile(abs);
    res.writeHead(200, {
      "content-type": TYPES[extname(abs)] || "application/octet-stream",
      "content-length": info.size,
      // A custody photo is a capability URL; keep it out of caches, frames and referrers.
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "same-origin",
    });
    res.end(body);
  } catch {
    send(res, 404, "not found");
  }
}

/* ————————————————————————— API ————————————————————————— */

async function api(req, res, url) {
  const path = url.pathname;
  const method = req.method.toUpperCase();

  if (method === "GET" && path === "/api/health") {
    const { brand } = await BRAND_SYNC;
    const authed = isDispatch(req);
    // The full path names the depot machine; a stranger gets the file name only.
    return send(res, 200, { ok: true, service: brand.haul.brand, shipments: store.size,
      db: authed ? DB : basename(DB), dispatch: authed });
  }

  if (method === "GET" && path === "/api/brand") {
    const st = await BRAND_SYNC;
    return send(res, 200, { ok: true, parent: st.brand.parent, attribution: st.brand.attribution, tokens: st.brand.tokens, studio: st.brand.studio, haul: st.brand.haul, source: st.source, fetchedAt: st.fetchedAt, cached: !!st.cached });
  }

  if (method === "GET" && path === "/api/config") {
    const st = await BRAND_SYNC;
    return send(res, 200, {
      ok: true,
      contact: contactForHaul(st.brand),
      brand: { parent: st.brand.parent, attribution: st.brand.attribution, tokens: st.brand.tokens, source: st.source, fetchedAt: st.fetchedAt, cached: !!st.cached, site: st.brand.parent.site },
      config: CONFIG,
      services: SERVICES,
      statuses: STATUSES,
      exception: EXCEPTION_STATUS,
    });
  }

  if (method === "GET" && path === "/api/places")
    return send(res, 200, { ok: true, all: PLACES, origins: ORIGINS, destinations: DESTINATIONS });

  if (method === "GET" && path === "/api/quote") {
    const q = Object.fromEntries(url.searchParams);
    const price = quote(coerce(q));
    return send(res, price.ok ? 200 : 422, price);
  }

  if (method === "POST" && path === "/api/quote") {
    const price = quote(coerce(await readBody(req)));
    return send(res, price.ok ? 200 : 422, price);
  }

  // — the whole manifest is dispatch-only —
  if (method === "GET" && path === "/api/shipments") {
    if (!isDispatch(req)) return unauthorized(res);
    return send(res, 200, {
      ok: true,
      stats: store.stats(),
      statuses: STATUSES,
      shipments: store.list({ status: url.searchParams.get("status"), q: url.searchParams.get("q") }, (r) => store.dispatchView(r)),
    });
  }

  // — booking stays public: that is the point of the app —
  if (method === "POST" && path === "/api/shipments") {
    if (!isDispatch(req) && !bookAllowed(clientIp(req)))
      return send(res, 429, {
        ok: false,
        error: "too many bookings",
        message: "Too many bookings from this connection. Try again in ten minutes.",
      });
    const result = store.create(coerce(await readBody(req)));
    if (!result.ok) return badRequest(res, "Booking rejected", result.errors);
    // The plaintext PIN is handed to the booker once and never stored again.
    return send(res, 201, { ok: true, ...store.publicView(result.shipment), pin: result.pin });
  }

  const m = path.match(/^\/api\/shipments\/([^/]+)$/);
  if (m) {
    const code = decodeURIComponent(m[1]);
    if (!isValidCode(code)) return badRequest(res, `"${code}" is not a tracking code. They look like BH-7K2M9X.`);
    const s = store.get(code);
    if (!s) return notFound(res, code);
    const authed = isDispatch(req);

    if (method === "GET")
      return send(res, 200, { ok: true, statuses: STATUSES, ...(authed ? store.dispatchView(s) : store.publicView(s)) });

    if (method === "PATCH") {
      const body = await readBody(req);

      // The driver's door check stays reachable without the token — a collector
      // on a phone in the middle of leg traffic has neither. It is throttled.
      if (body.action === "verify-pin") {
        const key = `${code}|${clientIp(req)}`;
        if (!pinAllowed(key))
          return send(res, 429, {
            ok: false,
            error: "too many attempts",
            message: "Too many PIN attempts on this code. Wait ten minutes and try again.",
          });
        const r = store.verifyPin(code, body.pin);
        return send(res, r.ok ? 200 : 422, r);
      }

      if (!authed) return unauthorized(res); // everything below changes the manifest

      if (body.action === "exception") {
        const r = store.exception(code, body.note);
        return r.ok ? send(res, 200, { ok: true, shipment: store.dispatchView(r.shipment) }) : badRequest(res, "Could not flag", r.errors);
      }
      const r = store.advance(code, { status: body.status, note: body.note, by: body.by || "dispatch" });
      return r.ok ? send(res, 200, { ok: true, shipment: store.dispatchView(r.shipment) }) : badRequest(res, "Could not advance", r.errors);
    }
  }

  const pm = path.match(/^\/api\/shipments\/(BH-[A-Z2-9]{6})\/photos$/);
  if (pm && method === "POST") {
    if (!isDispatch(req)) return unauthorized(res);
    const code = pm[1];
    if (!store.get(code)) return notFound(res, code);
    const body = await readBody(req, MAX_PHOTO);
    const r = await savePhoto(code, body.data || body.photo, body.note, body.by || "dispatch");
    if (!r.ok) {
      // The same sentence on both keys — the UI reads `message`, older callers read `error`.
      const msg = r.message || r.errors?.[0]?.message || "Photo rejected";
      return send(res, r.message ? 422 : 400, { ok: false, error: msg, message: msg, errors: r.errors || [] });
    }
    return send(res, 201, { ok: true, photo: { url: `photos/${code}/${r.photo.file}`, at: r.photo.at, note: r.photo.note }, shipment: store.dispatchView(r.shipment) });
  }

  return send(res, 404, { ok: false, error: `no route ${method} ${path}` });
}

/** Query strings arrive as text; the pricing engine wants numbers/booleans.
 *  "false" is a truthy string, so every boolean the engine tests has to be listed
 *  here — an omitted one (oversize used to be) silently priced the option IN. */
function coerce(o = {}) {
  const out = { ...o };
  for (const k of ["pieces", "weightKg", "declaredValue"]) if (k in out && out[k] !== "") out[k] = Number(out[k]);
  for (const k of ["insurance", "fragile", "oversize"]) if (k in out) out[k] = out[k] === true || out[k] === "true" || out[k] === "1";
  for (const k of ["service", "fromId", "toId", "promo"]) if (k in out) out[k] = out[k] ? String(out[k]) : undefined;
  return out;
}

/** Only these prefixes are public. server.mjs, tools/ and data/ stay private
 *  even though they live under ROOT. */
const PUBLIC = [/^index\.html$/, /^styles\//, /^app\//, /^core\//, /^assets\//, /^favicon\.ico$/, /^robots\.txt$/, /^site\.webmanifest$/, /^sw\.js$/];

async function serveStatic(res, pathname) {
  const abs = normalize(join(ROOT, decodeURIComponent(pathname)));
  // The allowlist is matched against the *normalised, rooted* path — testing the
  // raw URL would let "/core/../server.mjs" through on a /^core\// match.
  const rel = abs === ROOT ? "index.html" : abs.slice(ROOT.length + 1).split(sep).join("/");
  // index.html carries the studio's tokens, injected at serve time — never the raw file.
  if (rel === "index.html") return shell(res);
  const withinRoot = abs === ROOT || abs.startsWith(ROOT + sep);
  const isPublic = PUBLIC.some((re) => re.test(rel));
  if (!withinRoot || !isPublic) {
    // Unknown extensionless paths fall through to the SPA shell so a refresh works.
    if (!extname(abs) && withinRoot) return shell(res);
    return send(res, 404, "not found");
  }
  try {
    const info = await stat(abs);
    if (info.isDirectory()) throw new Error("dir");
    const body = await readFile(abs);
    res.writeHead(200, {
      "content-type": TYPES[extname(abs)] || "application/octet-stream",
      "content-length": info.size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  } catch {
    if (!extname(abs) || extname(abs) === ".html") return shell(res);
    send(res, 404, "not found");
  }
}

/** index.html carries `<!--BRAND-->` in <head>; it is replaced here so the
 *  studio's tokens are in the first paint — no flash of the old palette, and
 *  no client fetch before the shell can render. */
let SHELL = null;
async function shell(res) {
  try {
    if (!SHELL) {
      const st = await BRAND_SYNC;
      const raw = await readFile(join(ROOT, "index.html"), "utf8");
      SHELL = Buffer.from(raw.replace("<!--BRAND-->", brandStyleTag(st.brand, st.source)), "utf8");
    }
    res.writeHead(200, { "content-type": TYPES[".html"], "content-length": SHELL.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(SHELL);
  } catch {
    send(res, 404, "index.html missing — run this from the project folder");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (url.pathname.startsWith("/photos/")) return await servePhoto(res, url.pathname);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed");
    return await serveStatic(res, url.pathname);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error("[haul]", e);
    return send(res, status, { ok: false, error: e.message, message: e.message });
  }
});

/** First boot with no HAUL_TOKEN: mint one and show it exactly once. */
const firstToken = store.ensureToken(process.env.HAUL_TOKEN || null);

server.listen(PORT, HOST, () => {
  console.log(`BrownHub Haul · ${store.size} shipment(s) · http://${HOST}:${PORT}  (db: ${DB})`);
  console.log(`photos: ${PHOTO_DIR}`);
  if (firstToken) {
    console.log("");
    console.log("  Dispatch passphrase (shown once, never stored in plain text):");
    console.log(`    ${firstToken}`);
    console.log("  Enter it on the Dispatch screen. To change it later:");
    console.log("    HAUL_TOKEN='your new passphrase' node server.mjs");
    console.log("");
  } else {
    console.log(process.env.HAUL_TOKEN ? "  dispatch: protected by HAUL_TOKEN" : "  dispatch: protected by the stored passphrase");
  }
  console.log(`example quote: curl -s 'http://${HOST}:${PORT}/api/quote?fromId=kokomlemle&toId=kotoka&weightKg=18&pieces=2&service=express&insurance=true&declaredValue=4500'`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
