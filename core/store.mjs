/**
 * BrownHub Haul — shipment lifecycle & JSON store.
 *
 * Node-only (uses fs). The browser talks to it through /api, so there is
 * exactly one place where a shipment's state is decided.
 *
 * The file is written temp-then-rename: a crash mid-write leaves the previous
 * manifest intact instead of a truncated one.
 *
 * Two views of a record leave this module:
 *   publicView()   what the traveller's tracker gets — no PIN, no e-mail, the
 *                  phone masked. A tracking URL is shared on purpose, so it may
 *                  only ever contain what the traveller already knows.
 *   dispatchView() what the depot board gets, and only behind the depot token —
 *                  full contact details plus the unsealed handover PIN.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { quote, round, SERVICE_BY_ID } from "./pricing.mjs";
import { PLACE_BY_ID } from "./zones.mjs";
import { newCode, newPin, isValidCode, normalizeCode } from "./codes.mjs";
import { Lockbox, newToken } from "./lockbox.mjs";

export { newCode, newPin, isValidCode, normalizeCode } from "./codes.mjs";

export const STATUSES = [
  { key: "booked", label: "Booked", note: "Label and handover PIN issued. A collector is assigned the night before.", offsetH: 0 },
  { key: "collected", label: "Collected", note: "Luggage weighed, tagged and sealed at the door.", offsetH: 2 },
  { key: "in_transit", label: "In transit", note: "On the manifest for this leg. Not accessible to anyone but the named driver.", offsetH: 6 },
  { key: "arrived_hub", label: "Arrived at depot", note: "Checked in at the destination counter, waiting for the last-mile run.", offsetH: 10 },
  { key: "out_for_delivery", label: "Out for delivery", note: "On the final vehicle. The receiver gets a call 30 minutes ahead.", offsetH: 13 },
  { key: "delivered", label: "Delivered", note: "Handed over to the receiver against the four-digit PIN.", offsetH: 16 },
];

export const STATUS_BY_KEY = Object.fromEntries(STATUSES.map((s) => [s.key, s]));
export const EXCEPTION_STATUS = "delayed";

const REQUIRED = ["customerName", "customerPhone", "fromId", "toId", "pickupDate", "pickupWindow"];

/** Normalize + validate a booking payload. Returns {ok} or {ok:false, errors[]}. */
export function validateBooking(payload = {}) {
  const errors = [];
  const g = (k) => (payload[k] === undefined || payload[k] === null ? "" : String(payload[k]).trim());
  for (const f of REQUIRED) if (!g(f)) errors.push({ field: f, message: `${f} is required` });
  if (g("customerName").length < 2) errors.push({ field: "customerName", message: "Enter the traveller's name." });
  if (g("customerPhone").replace(/[^0-9]/g, "").length < 9)
    errors.push({ field: "customerPhone", message: "Enter a reachable phone number — the driver calls before collecting." });
  if (g("fromId") && !PLACE_BY_ID[g("fromId")]) errors.push({ field: "fromId", message: "Unknown collection point." });
  if (g("toId") && !PLACE_BY_ID[g("toId")]) errors.push({ field: "toId", message: "Unknown destination." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(g("pickupDate")))
    errors.push({ field: "pickupDate", message: "Pick-up date must be YYYY-MM-DD." });
  const pieces = Number(payload.pieces);
  const weightKg = Number(payload.weightKg);
  if (!(pieces >= 1 && pieces <= 6)) errors.push({ field: "pieces", message: "1–6 pieces." });
  if (!(weightKg > 0)) errors.push({ field: "weightKg", message: "Weight must be above 0kg." });
  if (g("service") && !SERVICE_BY_ID[g("service")]) errors.push({ field: "service", message: "Unknown service level." });
  const price = quote(payload);
  if (!price.ok) errors.push(...price.errors);
  return errors.length ? { ok: false, errors } : { ok: true, price };
}

export class Store {
  /**
   * @param file  the manifest JSON
   * @param lock  a Lockbox; defaults to data/secret.key beside the manifest
   */
  constructor(file, { lock } = {}) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    this.lock = lock || new Lockbox(join(dirname(file), "secret.key"));
    this.data = existsSync(file) ? this.#read() : { shipments: [] };
    if (!Array.isArray(this.data.shipments)) this.data.shipments = [];
    if (!this.data.meta || typeof this.data.meta !== "object") this.data.meta = {};
    this.#seedDemo();
    this.#sealLegacyPins();
  }

  #read() {
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch (e) {
      // Never trust a file we cannot parse into a blank manifest — refuse loudly.
      throw new Error(`store: ${this.file} is corrupt (${e.message}). Restore it or move it aside.`);
    }
  }

  #flush() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  /** Manifests written before the lockbox stored the handover PIN in plain text.
   *  Sealing it on load is not optional — the old file is a list of door codes
   *  until it is rewritten, and every copy of it back and to the depot keeps one. */
  #sealLegacyPins() {
    let moved = 0;
    for (const s of this.data.shipments) {
      const plain = typeof s.pin === "string" ? s.pin : null;
      if (plain && !s.pinSeal) {
        s.pinSeal = this.lock.seal(plain);
        moved++;
      }
      if ("pin" in s) delete s.pin; // never let a readable PIN survive the rewrite
      if (!s.photos) s.photos = [];
    }
    if (moved) {
      this.#flush();
      console.log(`[haul] sealed ${moved} plain-text handover PIN(s) in ${this.file}`);
    }
  }

  /* ————————————————————————— depot token ————————————————————————— */

  /** The token is stored only as an HMAC, so the manifest alone cannot mint one.
   *  Returns the plaintext exactly once — when it is created or reset. */
  ensureToken(preferred) {
    if (preferred) {
      const wanted = String(preferred).trim(); // checkToken trims; a "HAUL_TOKEN\n" must not lock the desk out
      if (this.data.meta.tokenMac && this.lock.matches(wanted, this.data.meta.tokenMac)) return null;
      this.data.meta.tokenMac = this.lock.mac(wanted).toString("hex");
      this.data.meta.tokenSetAt = new Date().toISOString();
      this.#flush();
      return wanted;
    }
    if (this.data.meta.tokenMac) return null;
    const token = newToken();
    this.data.meta.tokenMac = this.lock.mac(token).toString("hex");
    this.data.meta.tokenSetAt = new Date().toISOString();
    this.#flush();
    return token;
  }

  checkToken(candidate) {
    if (!this.data.meta.tokenMac) return false; // no token configured: nothing to match against
    if (typeof candidate !== "string" || !candidate) return false;
    return this.lock.matches(candidate.trim(), this.data.meta.tokenMac);
  }

  get tokenConfigured() {
    return !!this.data.meta.tokenMac;
  }

  /* ————————————————————————— views ————————————————————————— */

  /** What the tracker may say about a haul. Anything here can end up on a screen
   *  the traveller forwarded to a friend. */
  publicView(s) {
    const { pinSeal, pin, ...rest } = s;
    return {
      ...rest,
      customer: { name: s.customer.name, phone: maskPhone(s.customer.phone), email: undefined },
      pin: undefined,
      photos: (s.photos || []).map((p) => ({ url: `photos/${s.code}/${p.file}`, at: p.at, note: p.note || "" })),
    };
  }

  /** What the authenticated dispatch board sees: the same record, plus the
   *  contact details and the PIN unsealed for reading aloud. */
  dispatchView(s) {
    const view = { ...s, pin: this.lock.open(s.pinSeal) ?? "unavailable", photos: (s.photos || []).map((p) => ({ url: `photos/${s.code}/${p.file}`, at: p.at, note: p.note || "" })) };
    delete view.pinSeal;
    return view;
  }

  /* ————————————————————————— reads ————————————————————————— */

  list({ status, q } = {}, view = (x) => x) {
    let rows = this.data.shipments.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (status && status !== "all") rows = rows.filter((r) => r.status === status);
    if (q) {
      const needle = q.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.code.toLowerCase().includes(needle) ||
          r.customer.name.toLowerCase().includes(needle) ||
          r.from.name.toLowerCase().includes(needle) ||
          r.to.name.toLowerCase().includes(needle)
      );
    }
    return rows.map(view);
  }

  get(code) {
    const key = String(code || "").trim().toUpperCase();
    return this.data.shipments.find((r) => r.code === key) || null;
  }

  /* ————————————————————————— writes ————————————————————————— */

  create(payload) {
    const check = validateBooking(payload);
    if (!check.ok) return { ok: false, errors: check.errors };
    let code;
    do code = newCode(); while (this.get(code));
    const now = new Date().toISOString();
    const pin = newPin();
    const s = {
      code,
      status: "booked",
      createdAt: now,
      customer: {
        name: String(payload.customerName).trim(),
        phone: String(payload.customerPhone).trim(),
        email: String(payload.customerEmail || "").trim(),
      },
      from: place(payload.fromId),
      to: place(payload.toId),
      address: String(payload.address || "").trim(),
      reference: String(payload.reference || "").trim(),
      logistics: {
        pieces: Number(payload.pieces),
        weightKg: Number(payload.weightKg),
        service: payload.service || "standard",
        insurance: !!payload.insurance,
        declaredValue: Number(payload.declaredValue) || 0,
        fragile: !!payload.fragile,
        oversize: !!payload.oversize,
        notes: String(payload.notes || "").trim(),
      },
      pickup: { date: payload.pickupDate, window: payload.pickupWindow },
      price: check.price,
      total: round(check.price.total),
      pinSeal: this.lock.seal(pin), // the plaintext PIN is returned once and never stored
      driver: null,
      photos: [],
      history: [event("booked", `Booked, collecting ${payload.pickupDate} ${payload.pickupWindow}`, 0)],
    };
    this.data.shipments.push(s);
    this.#flush();
    return { ok: true, shipment: s, pin };
  }

  advance(code, { status, note, by, now = new Date() } = {}) {
    const s = this.get(code);
    if (!s) return { ok: false, errors: [{ field: "code", message: "Not found" }] };
    const order = STATUSES.map((x) => x.key);
    const current = order.indexOf(s.status);
    const next =
      status && STATUS_BY_KEY[status]
        ? status
        : s.status === EXCEPTION_STATUS
        ? order[Math.min(current, order.length - 1)] || "in_transit"
        : order[current + 1];
    if (!next) return { ok: false, errors: [{ field: "status", message: `${s.code} is already delivered.` }] };
    if (status && status === s.status)
      return { ok: false, errors: [{ field: "status", message: `Already ${status}.` }] };
    s.status = next;
    s.history.push(event(next, note || STATUS_BY_KEY[next].note, 0, by || "dispatch"));
    s.updatedAt = now.toISOString();
    if (next === "out_for_delivery" && !s.driver)
      s.driver = { name: "Kwesi Appiah", phone: "+233 55 398 0791", vehicle: "GT 4821-24 · Panel van" };
    this.#flush();
    return { ok: true, shipment: s };
  }

  /** The last-mile handover check. The PIN is unsealed and compared in constant
   *  time; the answer says yes/no and nothing else — a refused or accepted check
   *  must not hand back the traveller's address. */
  verifyPin(code, pin) {
    const s = this.get(code);
    if (!s) return { ok: false, message: "Unknown tracking code." };
    const stored = this.lock.open(s.pinSeal);
    const candidate = String(pin ?? "").trim();
    const match = !!stored && candidate.length === stored.length &&
      timingSafeEqual(Buffer.from(candidate), Buffer.from(stored));
    return {
      ok: match,
      message: match
        ? `Handover accepted for ${s.customer.name}.`
        : "That PIN does not match this shipment. Ask the traveller to read it again.",
      name: match ? s.customer.name : undefined,
    };
  }

  exception(code, reason) {
    const s = this.get(code);
    if (!s) return { ok: false, errors: [{ field: "code", message: "Not found" }] };
    s.status = EXCEPTION_STATUS;
    s.history.push({ status: EXCEPTION_STATUS, at: new Date().toISOString(), note: reason || "Delay reported", by: "dispatch" });
    this.#flush();
    return { ok: true, shipment: s };
  }

  /** Record a custody photo already written to disk by the server. */
  addPhoto(code, { file, note, by = "dispatch", size = 0 }) {
    const s = this.get(code);
    if (!s) return { ok: false, errors: [{ field: "code", message: "Not found" }] };
    if (!/^[A-Za-z0-9._-]{1,64}\.(jpg|png)$/.test(file)) return { ok: false, errors: [{ field: "file", message: "Bad file name" }] };
    s.photos = s.photos || [];
    const record = { file, at: new Date().toISOString(), by, note: String(note || "").slice(0, 160), bytes: size };
    s.photos.push(record);
    s.history.push({ status: s.status, at: record.at, note: `Custody photo ${s.photos.length} added${record.note ? ` — ${record.note}` : ""}`, by });
    this.#flush();
    return { ok: true, shipment: s, photo: record };
  }

  stats() {
    const rows = this.data.shipments;
    const open = rows.filter((r) => r.status !== "delivered" && r.status !== EXCEPTION_STATUS);
    return {
      total: rows.length,
      open: open.length,
      delivered: rows.filter((r) => r.status === "delivered").length,
      delayed: rows.filter((r) => r.status === EXCEPTION_STATUS).length,
      pipelineValue: round(open.reduce((s, r) => s + r.total, 0)),
      revenue: round(rows.filter((r) => r.status === "delivered").reduce((s, r) => s + r.total, 0)),
      pieces: rows.reduce((s, r) => s + r.logistics.pieces, 0),
      kg: round(rows.reduce((s, r) => s + r.logistics.weightKg, 0)),
      photos: rows.reduce((s, r) => s + (r.photos?.length || 0), 0),
    };
  }

  get size() {
    return this.data.shipments.length;
  }

  #seedDemo() {
    if (this.data.shipments.length) return;
    const price = quote({
      fromId: "kokomlemle",
      toId: "kotoka",
      pieces: 2,
      weightKg: 23,
      service: "express",
      insurance: true,
      declaredValue: 4500,
      fragile: false,
      pickupDate: iso(new Date()),
    });
    const today = iso(new Date());
    const s = {
      code: "BH-D3MO24",
      status: "in_transit",
      createdAt: new Date(Date.now() - 9 * 3600 * 1000).toISOString(),
      customer: { name: "Ama Boateng", phone: "+233 53 558 3460", email: "" },
      from: place("kokomlemle"),
      to: place("kotoka"),
      address: "No. 14 Olive Drive, House 3",
      reference: "SK 508 · 15:40 departure",
      logistics: { pieces: 2, weightKg: 23, service: "express", insurance: true, declaredValue: 4500, fragile: false, oversize: false, notes: "Two cabin cases and a checked suitcase." },
      pickup: { date: today, window: "10:00 – 12:00" },
      price,
      total: round(price.total),
      pinSeal: this.lock.seal("4729"), // the demo PIN, for the tracker's driver check
      driver: { name: "Kwesi Appiah", phone: "+233 55 398 0791", vehicle: "GT 4821-24 · Panel van" },
      photos: [],
      history: [
        event("booked", "Booked on the BrownHub site", -9),
        event("collected", "2 pieces + 1 suitcase sealed at the door", -6),
        event("in_transit", "Loaded on the KIA morning leg", -3),
      ],
    };
    this.data.shipments.push(s);
    this.#flush();
  }
}

function place(id) {
  const p = PLACE_BY_ID[id];
  return { id: p.id, name: p.name, area: p.area, tier: p.tier, counter: p.counter || null };
}

function event(status, note, hoursOffset = 0, by = "system") {
  return {
    status,
    note,
    by,
    at: new Date(Date.now() + hoursOffset * 3600 * 1000).toISOString(),
  };
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

/** +233 53 558 3460 → "23353 ••• 460" — enough for the traveller to recognise
 *  their own number, not enough to harvest a list of them. */
function maskPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length < 7) return "••• •••";
  return `${digits.slice(0, digits.length - 6)} ••• ${digits.slice(-3)}`;
}
