/**
 * BrownHub Haul — pricing & SLA engine.
 *
 * Imported by BOTH server.mjs (authoritative quotes) and the browser (live
 * preview while the traveller types). It is pure: no I/O, no clock, no globals.
 * The date-dependent rules take an explicit `now`, so a quote can be replayed
 * in a test and never drifts.
 *
 * Money is carried in cedis as floats and rounded once, at the end (round()).
 * That keeps the arithmetic readable; the server re-rounds on write so the two
 * sides can never disagree by more than a pesewa.
 */

import { getPlace, legKm, HUB_TIER } from "./zones.mjs";

export const CURRENCY = "GHS";

export const CONFIG = {
  base: 45, // collection, labelling, tracking admin
  legMin: 25, // a leg never costs less than this in distance terms
  perKm: [
    { upTo: 60, rate: 3.5 }, // city / metro
    { upTo: 300, rate: 2.2 }, // regional
    { upTo: Infinity, rate: 1.6 }, // long haul
  ],
  roadFactor: 1.35, // straight-line km → drivable km
  extraPiece: 20,
  includedWeightKg: 5,
  weightTiers: [
    { upTo: 15, rate: 2.0 },
    { upTo: 25, rate: 3.2 },
    { upTo: Infinity, rate: 4.5 },
  ],
  fragileRate: 0.08, // of the handling subtotal
  oversizeFee: 45, // bulky-item handling: sports gear, instruments, crates
  insuranceRate: 0.03, // of declared value
  insuranceMin: 15,
  maxDeclaredValue: 60000,
  weekendRate: 0.12,
  crossBorderFee: 180,
  vatRate: 0.15,
  minimumCharge: 65,
  promos: {
    BHHAUL10: { kind: "pct", value: 0.1, cap: 100, label: "Launch offer −10%" },
    TRAVEL50: { kind: "flat", value: 50, label: "−GH₵50 on your first haul" },
  },
};

/** The collection promise is stated ONCE, from `handlingHours`. Hand-written blurbs
 *  had already drifted from the SLA the engine quotes (the Standard card promised 4 h
 *  while the quote line said 8 h), so the sentence is generated from the number. */
export const collectWithin = (hours) =>
  hours >= 2 ? `within ${hours} working hours` : `within ${hours * 60} minutes`;

const SERVICE_DEFS = [
  {
    id: "standard",
    label: "Standard",
    tail: "delivered on the next available run.",
    multiplier: 1,
    surcharge: 0,
    kmh: 42,
    handlingHours: 8,
    slots: "09:00 – 18:00",
  },
  {
    id: "express",
    label: "Express",
    tail: "priority on the manifest, delivered before the cut-off.",
    multiplier: 1.45,
    surcharge: 0,
    kmh: 58,
    handlingHours: 3,
    slots: "06:00 – 21:00",
  },
  {
    id: "sameday",
    label: "Same-day VIP",
    tail: "one dedicated driver — the luggage never leaves the vehicle.",
    multiplier: 1.9,
    surcharge: 60,
    kmh: 66,
    handlingHours: 1,
    slots: "06:00 – 22:00",
  },
];

export const SERVICES = SERVICE_DEFS.map((s) => ({
  ...s,
  blurb: `Collected ${collectWithin(s.handlingHours)}, ${s.tail}`,
}));

export const SERVICE_BY_ID = Object.fromEntries(SERVICES.map((s) => [s.id, s]));

export const MAX_WEIGHT_KG = 40; // per piece contract limit, enforced per shipment here
export const MAX_PIECES = 6;

const HOUR = 3600 * 1000;

export function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function formatGHS(n) {
  return "GH₵" + round(n).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function tieredCost(total, tiers, included) {
  let cost = 0;
  let prev = included;
  for (const t of tiers) {
    const band = Math.max(0, Math.min(total, t.upTo) - prev);
    cost += band * t.rate;
    prev = t.upTo;
    if (total <= t.upTo) break;
  }
  return cost;
}

function distanceCost(km) {
  let cost = 0;
  let prev = 0;
  for (const band of CONFIG.perKm) {
    const inBand = Math.max(0, Math.min(km, band.upTo) - prev);
    cost += inBand * band.rate;
    prev = band.upTo;
    if (km <= band.upTo) break;
  }
  return cost;
}

function isWeekend(isoDate) {
  const d = new Date(isoDate + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/** Add `hours` to a timestamp and snap to the end of the next staffed window. */
export function arriveBy(pickupISO, hours, slotEnd = "18:00") {
  const t = new Date(new Date(pickupISO).getTime() + hours * HOUR);
  const [hh, mm] = slotEnd.split(":").map(Number);
  if (t.getUTCHours() >= hh) t.setUTCDate(t.getUTCDate() + 1);
  t.setUTCHours(hh, mm, 0, 0);
  return t;
}

/**
 * @param {object} input
 * @param {string} input.fromId      place luggage leaves from
 * @param {string} input.toId        destination place
 * @param {number} input.pieces      1..MAX_PIECES
 * @param {number} input.weightKg    total across all pieces
 * @param {number} [input.declaredValue] value protected by the insurance add-on
 * @param {boolean} [input.insurance]
 * @param {boolean} [input.fragile]
 * @param {string} [input.pickupDate] YYYY-MM-DD — weekend pickup pricing
 * @param {string} [input.service]   standard | express | sameday
 * @param {string} [input.promo]
 * @param {Date|string} [input.now]  injectable clock
 */
export function quote(input = {}, now = new Date()) {
  const errors = [];
  const warnings = [];
  const c = CONFIG;

  const from = input.fromId ? safePlace(input.fromId, "fromId", errors) : null;
  const to = input.toId ? safePlace(input.toId, "toId", errors) : null;
  if (!from && !input.fromId) errors.push({ field: "fromId", message: "Tell us where to collect the luggage." });
  if (!to && !input.toId) errors.push({ field: "toId", message: "Tell us where it should arrive." });
  if (from && to && from.id === to.id)
    errors.push({ field: "toId", message: "Pick-up and drop-off cannot be the same place." });

  const pieces = intOr(input.pieces, 1);
  const weightKg = numOr(input.weightKg, 0);
  const declaredValue = numOr(input.declaredValue, 0);
  if (pieces < 1 || pieces > MAX_PIECES)
    errors.push({ field: "pieces", message: `Between 1 and ${MAX_PIECES} pieces per booking.` });
  if (weightKg <= 0) errors.push({ field: "weightKg", message: "Enter the total weight of the luggage." });
  if (weightKg > MAX_WEIGHT_KG * MAX_PIECES)
    errors.push({ field: "weightKg", message: `Over ${MAX_WEIGHT_KG * MAX_PIECES}kg needs a freight quote — call the depot.` });
  if (weightKg > 0 && pieces > 0 && weightKg / pieces > MAX_WEIGHT_KG)
    warnings.push(`Single-piece limit is ${MAX_WEIGHT_KG}kg — split the load across more pieces.`);

  const serviceId = input.service && SERVICE_BY_ID[input.service] ? input.service : "standard";
  const service = SERVICE_BY_ID[serviceId];
  if (input.service && !SERVICE_BY_ID[input.service])
    errors.push({ field: "service", message: `Unknown service "${input.service}".` });

  if (errors.length) return { ok: false, errors, warnings };

  const km = round(legKm(from.id, to.id) * c.roadFactor);
  const lines = [];

  lines.push({ key: "base", label: "Collection & handling", amount: c.base });
  const dist = Math.max(c.legMin, distanceCost(km));
  lines.push({ key: "distance", label: `Leg · ${km.toFixed(0)} km`, amount: round(dist) });

  const weight = tieredCost(weightKg, c.weightTiers, c.includedWeightKg);
  lines.push({
    key: "weight",
    label: `Weight · ${weightKg}kg (${c.includedWeightKg}kg included)`,
    amount: round(weight),
  });

  if (pieces > 1)
    lines.push({ key: "pieces", label: `Extra pieces · ${pieces - 1}`, amount: round((pieces - 1) * c.extraPiece) });

  const handling = lines.reduce((s, l) => s + l.amount, 0);

  if (input.fragile)
    lines.push({ key: "fragile", label: "Fragile / white-glove", amount: round(handling * c.fragileRate) });

  if (input.oversize)
    lines.push({ key: "oversize", label: "Oversize handling", amount: c.oversizeFee });

  if (from.id !== to.id && (from.intl || to.intl))
    lines.push({ key: "border", label: "Cross-border documentation", amount: c.crossBorderFee });

  if (to.tier === HUB_TIER)
    warnings.push("Counter drop-off: someone collects the luggage at the desk — we hand it over, not deliver to a room.");

  // Transit cover is priced on the freight subtotal but is NOT freight, so the
  // service multiplier must not inflate it — a Same-day VIP does not make the
  // insurance company charge more.
  const freight = lines.reduce((s, l) => s + l.amount, 0);

  if (input.insurance) {
    if (declaredValue <= 0)
      warnings.push("Cover was requested without a declared value — we insure the declared value only.");
    const capped = Math.min(Math.max(declaredValue, 0), c.maxDeclaredValue);
    if (declaredValue > c.maxDeclaredValue)
      warnings.push(`Declared value is capped at ${formatGHS(c.maxDeclaredValue)} for cover.`);
    lines.push({
      key: "insurance",
      label: `Transit cover · ${formatGHS(capped)} declared`,
      amount: round(Math.max(c.insuranceMin, capped * c.insuranceRate)),
    });
  }

  const afterService = freight * service.multiplier + service.surcharge;
  if (serviceId !== "standard")
    lines.push({ key: "service", label: `${service.label} service`, amount: round(afterService - freight) });

  if (serviceId === "sameday" && isWeekend(input.pickupDate || ""))
    warnings.push("Same-day VIP on a weekend runs the holiday roster — collection within 2 hours instead of 30 minutes.");

  const subtotal = round(lines.reduce((s, l) => s + l.amount, 0));

  let discount = 0;
  let promoLabel = null;
  const promo = input.promo ? String(input.promo).trim().toUpperCase() : "";
  if (promo) {
    const rule = c.promos[promo];
    if (!rule) errors.push({ field: "promo", message: `Code "${promo}" is not active.` });
    else {
      discount = rule.kind === "flat" ? rule.value : Math.min(subtotal * rule.value, rule.cap ?? Infinity);
      discount = round(Math.min(discount, subtotal));
      promoLabel = `${promo} · ${rule.label}`;
    }
  }
  if (errors.length) return { ok: false, errors, warnings };

  const weekendSurcharge =
    isWeekend(input.pickupDate || "") && serviceId !== "sameday"
      ? round((subtotal - discount) * c.weekendRate)
      : 0;
  if (weekendSurcharge) lines.push({ key: "weekend", label: "Weekend collection", amount: weekendSurcharge });

  const net = round(subtotal - discount + weekendSurcharge);
  const vat = round(net * c.vatRate);
  const total = round(Math.max(c.minimumCharge, net + vat));

  const pickup = input.pickupDate ? new Date(`${input.pickupDate}T09:00:00Z`) : null;
  const scheduled = !!pickup && !Number.isNaN(pickup.getTime());
  const travelHours = km / service.kmh + service.handlingHours;
  const eta = arriveBy(scheduled ? pickup : now, travelHours, service.slots.split(" – ")[1]);

  return {
    ok: true,
    currency: CURRENCY,
    symbol: "GH₵",
    lines,
    subtotal,
    discount,
    promoLabel,
    vat,
    total,
    net,
    minimumChargeApplied: net + vat < c.minimumCharge,
    distance: { km, straightLine: round(legKm(from.id, to.id)) },
    sla: {
      service: serviceId,
      label: service.label,
      handlingHours: service.handlingHours,
      travelHours: round(travelHours),
      pickupScheduled: scheduled,
      etaISO: eta.toISOString(),
      etaLabel: etaLabel(eta),
      deadlineISO: new Date(eta.getTime() - 2 * HOUR).toISOString(),
      collectWindow: service.slots,
    },
    estimate: { hours: Math.max(1, Math.round(travelHours)), collectWithin: service.handlingHours },
    warnings,
  };
}

function etaLabel(d) {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  if (sameDay) return `by ${time} today`;
  const tomorrow = new Date(now.getTime() + 24 * HOUR);
  if (d.toDateString() === tomorrow.toDateString()) return `by ${time} tomorrow`;
  return `by ${time}, ${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })}`;
}

function safePlace(id, field, errors) {
  try {
    return getPlace(id);
  } catch {
    errors.push({ field, message: `Unknown place "${id}".` });
    return null;
  }
}

function intOr(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}
function numOr(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
