#!/usr/bin/env node
/**
 * BrownHub Studio brand sync — SERVER ONLY (uses node:fs; never import from app/js).
 *
 * Haul is not its own brand: it is an app the studio ships. So the app does not
 * own its colours, its address or its phone number — it reads them from the
 * studio's website at boot and caches the last good copy for the depot laptop.
 *
 * Sources, in order:
 *   1. /data/haul.json   the structured contract the studio publishes (preferred)
 *   2. /llms.txt         the studio's machine-readable summary + /css/style.css tokens
 *   3. data/brand.json   the last successful sync
 *   4. FALLBACK          bundled last-known values, so a first boot offline still works
 *
 * Everything fetched is untrusted: tokens are whitelisted by name and value
 * (a colour or a length, never `url()`), text is stripped of newlines and caps,
 * links must be http(s). Nothing from the network is ever interpolated as HTML
 * without escaping.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_SITE = "https://www.brownhub283.com/";
export const BRAND_VERSION = 1;

/** Last-known values, taken from the live site on 2026-10-27. */
export const FALLBACK = deepFreeze({
  version: BRAND_VERSION,
  parent: {
    name: "BrownHub",
    displayName: "BrownHub Studio",
    descriptor: "graphic design and website company in Accra, Ghana",
    site: "https://www.brownhub283.com/",
    tagline: "intellectual designs",
    city: "Accra, Ghana",
    logo: "https://www.brownhub283.com/images/logo.png",
  },
  attribution: "An app by BrownHub Studio",
  tokens: {
    bg: "#fffbf7",
    surface: "#ffffff",
    border: "#e9d6c6",
    text: "#26100f",
    "text-muted": "#6e5248",
    accent: "#c82027",
    "accent-fill-hover": "#a8181f",
    "accent-2": "#8a5e28",
    radius: "14px",
  },
  studio: {
    email: "howelldaniel533@gmail.com",
    emails: ["howelldaniel533@gmail.com", "anghadaniel621@gmail.com"],
    phone: "+233 53 558 3460",
    whatsapp: "233502954541",
    whatsappLink: "https://wa.me/233502954541",
    address: "ChrisPrintgh, Accra New Town, Accra, Ghana",
    hours: "Mon–Fri, 9am–6pm GMT",
    services: [],
  },
  haul: {
    brand: "BrownHub Haul",
    tagline: "luggage, handled",
    app: "",
    page: "https://www.brownhub283.com/haul.html",
    whatsapp: "233535583460",
    phone: "+233 53 558 3460",
    email: "howelldaniel533@gmail.com",
    hours: "Mon–Sat 06:00–21:00 · Sun & holidays 09:00–18:00",
    depot: {
      name: "BrownHub Depot",
      address: "New Heaven Preparatory School, Kokomlemle",
      maps: "https://maps.app.goo.gl/tof3h6ciUgqP9niWA",
    },
    counter: {
      name: "KIA desk",
      address: "Kotoka International Airport, Level 1",
      maps: "https://maps.app.goo.gl/J1d1eDiNE7C7bBoz8",
    },
  },
});

/* ————————————————————————— sanitising ————————————————————————— */

const HEX = /^#[0-9a-f]{3,8}$/i;
const RGB = /^rgba?\(\s*[\d.]+%?(?:\s*,\s*[\d.]+%?){2,3}\s*\)$/i;
const LENGTH = /^\d{1,3}(?:\.\d+)?(?:px|rem)$/;
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** A single line of text, capped. Never returns null — falls back. */
function txt(value, fallback = "", max = 160) {
  if (value === undefined || value === null) return fallback;
  const s = String(value).replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : fallback;
}

function colour(value, fallback) {
  const s = txt(value, "", 40);
  return HEX.test(s) || RGB.test(s) ? s : fallback;
}

function length(value, fallback) {
  const s = txt(value, "", 12);
  return LENGTH.test(s) ? s : fallback;
}

/** http(s) only — a `javascript:` href from a compromised feed must go nowhere. */
function link(value, fallback) {
  const raw = txt(value, "", 300);
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : fallback;
  } catch {
    return fallback;
  }
}

function digits(value) {
  const d = String(value ?? "").replace(/\D/g, "");
  return d.length >= 8 && d.length <= 15 ? d : "";
}

/* ————————————————————————— parsers ————————————————————————— */

/** The body of `## <name>` up to the next `## `. */
function section(text, name) {
  const head = new RegExp(`^##\\s+${name}\\s*$`, "m").exec(text);
  if (!head) return "";
  const rest = text.slice(head.index + head[0].length);
  const next = rest.search(/^##\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** llms.txt → parent identity, studio contacts, services. */
export function parseLlms(source = "") {
  const text = String(source);
  const parent = {};
  const studio = {};

  const h1 = text.match(/^#\s+(.+)$/m);
  if (h1) parent.name = txt(h1[1], FALLBACK.parent.name, 60);

  const overview = text.match(/^##\s+Overview\s*\n+([^\n#][^\n]*)/m);
  if (overview) {
    // "BrownHub is a graphic design and website company in Accra, Ghana, …"
    const sentence = overview[1].replace(/^[^.]*?\bis\s+(?:a|an|the)\s+/i, "").split(/(?<=[.;])\s/)[0];
    parent.descriptor = txt(sentence.replace(/[.;]$/, ""), FALLBACK.parent.descriptor, 160);
  }

  for (const line of section(text, "Company details").split("\n")) {
    const m = line.match(/^\s*[-*]\s*([^:]+):\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase().trim();
    const val = m[2];
    if (key.startsWith("website")) {
      parent.site = link(val.match(/https?:\/\/\S+/)?.[0], parent.site || FALLBACK.parent.site);
    } else if (key.startsWith("email")) {
      const mail = val.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
      if (mail) {
        studio.emails = [...(studio.emails || []), mail].slice(0, 4);
        studio.email ||= mail;
      }
    } else if (key.startsWith("phone")) {
      const phone = val.match(/\+?[\d][\d\s()-]{6,}/)?.[0]?.trim();
      studio.phone = txt(phone, studio.phone, 40);
    } else if (key === "whatsapp" || key.startsWith("whatsapp ")) {
      const num = digits(val.match(/wa\.me\/(\d+)/)?.[1]) || digits(val.match(/\+?[\d][\d\s-]{7,}/)?.[0]);
      if (num) {
        studio.whatsapp ||= num;
        studio.whatsappLink ||= `https://wa.me/${num}`;
      }
    } else if (key.startsWith("location") || key.startsWith("address")) {
      studio.address = txt(val, studio.address, 160);
    } else if (key.startsWith("hours")) {
      studio.hours = txt(val, studio.hours, 120);
    }
  }

  const services = section(text, "Services");
  if (services) {
    studio.services = services
      .split("\n")
      .filter((l) => /^\s*[-*]\s+/.test(l))
      .map((l) => txt(l.replace(/^\s*[-*]\s+/, "").replace(/:?\s*https?:\/\/\S+\s*$/, ""), "", 80))
      .filter(Boolean)
      .slice(0, 24);
  }

  return { parent, studio };
}

/** The homepage → the name the studio calls itself. og:site_name is the short
 *  brand ("BrownHub"); the JSON-LD alternateName and the iOS title carry the
 *  full "BrownHub Studio", which is how the company is named in conversation. */
export function parseSite(html = "") {
  const text = String(html);
  const alt = text.match(/"alternateName"\s*:\s*"([^"]{2,60})"/)?.[1];
  const ios = text.match(/<meta\s+name=["']apple-mobile-web-app-title["']\s+content=["']([^"']{2,60})["']/i)?.[1];
  const og = text.match(/<meta\s+property=["']og:site_name["']\s+content=["']([^"']{2,60})["']/i)?.[1];
  return { displayName: txt(alt, "") || txt(ios, "") || txt(og, "") };
}

/** The studio's published CSS → the light-theme token map. */
export function parseTokens(css = "") {
  const text = String(css);
  const block =
    text.match(/html\[data-theme=["']light["']\]\s*\{([^}]*)\}/i)?.[1] ??
    text.match(/^:root\s*\{([^}]*)\}/m)?.[1] ??
    "";
  const out = {};
  for (const pair of block.split(";")) {
    const i = pair.indexOf(":");
    if (i < 1) continue;
    const key = pair.slice(0, i).trim();
    if (!key.startsWith("--")) continue;
    out[key.slice(2)] = pair.slice(i + 1).trim();
  }
  return out;
}

/* ————————————————————————— normalisation ————————————————————————— */

/** Merge anything (a feed, a scrape, a cache file) over FALLBACK, validating
 *  every field on the way in. Always returns a complete, frozen brand. */
export function normalizeBrand(raw = {}) {
  const tokens = {};
  for (const [key, fallback] of Object.entries(FALLBACK.tokens)) {
    const v = raw?.tokens?.[key];
    tokens[key] = key === "radius" ? length(v, fallback) : colour(v, fallback);
  }

  const site = link(raw?.parent?.site, FALLBACK.parent.site);
  const s = raw?.studio || {};
  const emails = (Array.isArray(s.emails) ? s.emails : [s.email])
    .map((e) => txt(e, "", 80))
    .filter((e) => /^[\w.+-]+@[\w.-]+\.\w+$/.test(e))
    .slice(0, 4);

  const whatsapp = digits(s.whatsapp) || digits(String(s.whatsappLink || "").match(/wa\.me\/(\d+)/)?.[1]) || FALLBACK.studio.whatsapp;

  const h = raw?.haul && typeof raw.haul === "object" ? raw.haul : {};
  const place = (p, fb) => ({
    name: txt(p?.name, fb.name, 80),
    address: txt(p?.address, fb.address, 160),
    maps: link(p?.maps, fb.maps),
  });

  return deepFreeze({
    version: BRAND_VERSION,
    parent: {
      name: txt(raw?.parent?.name, FALLBACK.parent.name, 60),
      displayName: txt(raw?.parent?.displayName, FALLBACK.parent.displayName, 60),
      descriptor: txt(raw?.parent?.descriptor, FALLBACK.parent.descriptor, 160),
      site,
      tagline: txt(raw?.parent?.tagline, FALLBACK.parent.tagline, 60),
      city: txt(raw?.parent?.city, FALLBACK.parent.city, 60),
      logo: link(raw?.parent?.logo, FALLBACK.parent.logo),
    },
    attribution: txt(raw?.attribution, FALLBACK.attribution, 80),
    tokens,
    studio: {
      email: emails[0] || txt(s.email, FALLBACK.studio.email, 80),
      emails: emails.length ? emails : FALLBACK.studio.emails.slice(),
      phone: txt(s.phone, FALLBACK.studio.phone, 40),
      whatsapp,
      whatsappLink: link(s.whatsappLink, `https://wa.me/${whatsapp}`),
      address: txt(s.address, FALLBACK.studio.address, 160),
      hours: txt(s.hours, FALLBACK.studio.hours, 120),
      services: (Array.isArray(s.services) ? s.services : []).map((x) => txt(x, "", 80)).filter(Boolean).slice(0, 24),
    },
    haul: {
      brand: txt(h.brand, FALLBACK.haul.brand, 60),
      tagline: txt(h.tagline, FALLBACK.haul.tagline, 60),
      app: link(h.app, ""),
      page: link(h.page, FALLBACK.haul.page),
      whatsapp: digits(h.whatsapp) || FALLBACK.haul.whatsapp,
      phone: txt(h.phone, FALLBACK.haul.phone, 40),
      email: txt(h.email, FALLBACK.haul.email, 80),
      hours: txt(h.hours, FALLBACK.haul.hours, 120),
      depot: place(h.depot, FALLBACK.haul.depot),
      counter: place(h.counter, FALLBACK.haul.counter),
    },
  });
}

/* ————————————————————————— what the app consumes ————————————————————————— */

/** Studio tokens → the app's own CSS custom properties. The app's stylesheet
 *  declares these names with its old values; the injected block lands after it
 *  and wins, so the app wears the studio palette without rewriting every rule. */
export function appTokens(brand) {
  const t = brand.tokens;
  return {
    "--paper": t.bg,
    "--card": t.surface,
    "--ink": t.text,
    "--ink-2": `color-mix(in srgb, ${t.text} 55%, ${t["text-muted"]})`,
    "--ink-3": t["text-muted"],
    "--line": t.border,
    "--line-2": `color-mix(in srgb, ${t.border} 55%, ${t.surface})`,
    "--red": t.accent,
    "--red-d": t["accent-fill-hover"],
    "--red-rgb": rgbTriplet(t.accent),
    "--brown": t["accent-2"],
    "--brown-d": `color-mix(in srgb, ${t["accent-2"]} 84%, #000)`,
    "--brown-rgb": rgbTriplet(t["accent-2"]),
    "--r": t.radius,
  };
}

/** "#c82027" → "200,32,39" so rgba(var(--red-rgb),.1) works. */
export function rgbTriplet(value) {
  const s = String(value).trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).join(",");
  }
  const nums = s.match(/\d+(?:\.\d+)?/g);
  return nums && nums.length >= 3 ? nums.slice(0, 3).join(",") : "200,32,39";
}

export function brandStyleTag(brand, source = "fallback") {
  const vars = Object.entries(appTokens(brand))
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  return `<style id="brand-tokens" data-source="${escapeAttr(source)}">:root{${vars}}</style>`;
}

function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** The contact block the API has always served, now derived from the studio. */
export function contactForHaul(brand) {
  const { haul: h, studio: s, parent } = brand;
  return {
    brand: h.brand,
    tagline: h.tagline,
    whatsapp: h.whatsapp,
    whatsappLink: `https://wa.me/${h.whatsapp}`,
    phone: h.phone,
    phoneLink: `tel:${h.phone.replace(/[^\d+]/g, "")}`,
    email: h.email || s.email,
    depot: h.depot,
    counter: h.counter,
    hours: h.hours,
    studio: {
      name: parent.displayName || parent.name,
      site: parent.site,
      tagline: parent.tagline,
      descriptor: parent.descriptor,
      city: parent.city,
      attribution: brand.attribution,
      address: s.address,
      email: s.email,
      emails: s.emails,
      phone: s.phone,
      phoneLink: `tel:${s.phone.replace(/[^\d+]/g, "")}`,
      whatsapp: s.whatsapp,
      whatsappLink: s.whatsappLink,
      hours: s.hours,
      services: s.services,
    },
  };
}

/* ————————————————————————— the sync ————————————————————————— */

async function getText(url, timeoutMs) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "text/plain,text/css,application/json;q=0.9,*/*;q=0.1", "user-agent": "BrownHub-Haul/brand-sync" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return await res.text();
}

function readCache(file) {
  if (!file) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw?.brand) return null;
    return { brand: normalizeBrand(raw.brand), source: txt(raw.source, "cache", 40), fetchedAt: txt(raw.fetchedAt, "", 40), site: link(raw.site, DEFAULT_SITE) };
  } catch {
    return null;
  }
}

function writeCache(file, entry) {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: BRAND_VERSION, ...entry }, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    console.warn(`[brand] could not cache to ${file}: ${e.message}`);
  }
}

/**
 * Fetch the studio identity. Never throws: a dead site, a slow site or a
 * malformed feed all end in a cached copy or the bundled fallback, and the
 * caller is told which one it got.
 */
export async function syncBrand({ site = DEFAULT_SITE, cache = null, offline = false, timeoutMs = 4000, log = () => {} } = {}) {
  const base = (() => {
    try {
      const u = new URL(site);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not http");
      return u;
    } catch {
      return new URL(DEFAULT_SITE);
    }
  })();
  const cached = readCache(cache);
  const now = new Date().toISOString();
  const done = (brand, source, extra = {}) => {
    const entry = { brand, source, site: base.href, fetchedAt: extra.fetchedAt || (extra.cached ? cached?.fetchedAt : now) || now, ...extra };
    log(`[brand] ${source}${entry.cached ? " (cached)" : ""}${entry.error ? ` — ${entry.error}` : ""}`);
    return entry;
  };

  if (offline) return done((cached?.brand ?? FALLBACK), cached ? `${cached.source} (cached, offline mode)` : "fallback (offline mode)", { cached: !!cached });

  // 1 — the structured contract, once the studio publishes it
  try {
    const json = JSON.parse(await getText(new URL("/data/haul.json", base), timeoutMs));
    const brand = normalizeBrand(json);
    writeCache(cache, { brand, source: "haul.json", fetchedAt: now, site: base.href });
    return done(brand, "haul.json", { fetchedAt: now, cached: false });
  } catch (e) {
    log(`[brand] no /data/haul.json (${e.message}) — reading the live pages`);
  }

  // 2 — what the studio publishes today: the summary + the stylesheet
  let scrapeError = "";
  try {
    const [llms, css, home] = await Promise.all([
      getText(new URL("/llms.txt", base), timeoutMs),
      getText(new URL("/css/style.css", base), timeoutMs),
      getText(new URL("/", base), timeoutMs),
    ]);
    const { parent, studio } = parseLlms(llms);
    const named = parseSite(home);
    const tokens = parseTokens(css);
    const brand = normalizeBrand({ parent: { ...parent, displayName: named.displayName }, studio, tokens });
    writeCache(cache, { brand, source: "llms.txt + style.css", fetchedAt: now, site: base.href });
    return done(brand, "llms.txt + style.css", { fetchedAt: now, cached: false });
  } catch (e) {
    scrapeError = e.message;
    log(`[brand] site unreadable (${e.message}) — using ${cached ? "the cache" : "bundled values"}`);
  }

  // 3 — the last good copy
  if (cached) return done(cached.brand, `${cached.source} (cached)`, { cached: true, error: scrapeError });

  // 4 — never fail a boot over a brand
  return done(FALLBACK, "bundled fallback", { cached: false, error: scrapeError });
}

function deepFreeze(o) {
  if (o && typeof o === "object") {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}
