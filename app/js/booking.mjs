/** Book a pickup. The panel on the right is a live preview computed with the
 *  SAME module the server uses (core/pricing.mjs) — the server re-quotes on
 *  submit and that number is what gets written to the manifest. */

import { $, $$, h, fill, money, dash, toast, addDaysISO, todayISO } from "./dom.mjs";
import { api } from "./api.mjs";
import { quote, CONFIG, SERVICES, SERVICE_BY_ID, collectWithin } from "../../core/pricing.mjs";
import { ORIGINS, DESTINATIONS, legKm } from "../../core/zones.mjs";

const form = () => $("#book-form");

export function mountBooking(ctx) {
  buildSelects();
  buildServices();
  $("#pickupDate").value = addDaysISO(0);
  $("#pickupDate").min = todayISO();
  $("#pickupDate").max = addDaysISO(45);
  form().addEventListener("input", refresh);
  form().addEventListener("change", refresh);
  form().addEventListener("submit", submit);
  $$("#confirm [data-close]").forEach((b) => b.addEventListener("click", closeConfirm));
  $("#conf-track").addEventListener("click", () => {
    const code = $("#conf-code").textContent.trim();
    closeConfirm(); // otherwise a stale dialog is still open when the traveller comes back to Book
    location.hash = "#/track";
    setTimeout(() => window.dispatchEvent(new CustomEvent("haul:track", { detail: code })), 60);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#confirm").hidden) closeConfirm();
  });
  refresh();
}

function buildSelects() {
  const groups = (list, blank) => {
    const opts = [];
    if (blank) opts.push(h("option", { value: "", "data-ph": "1" }, blank));
    const byTier = new Map();
    for (const p of list) {
      const key = p.intl ? "Outside Ghana" : p.tier === "hub" ? "BrownHub desk" : p.tier === "home" ? "Greater Accra" : p.area;
      if (!byTier.has(key)) byTier.set(key, []);
      byTier.get(key).push(p);
    }
    for (const [label, items] of byTier) {
      const og = h("optgroup", { label });
      // short labels: a long <option> sets the min-content width of the whole
      // grid column and pushes the page wider than a phone. Details go below it.
      for (const p of items) og.append(h("option", { value: p.id }, p.tier === "hub" ? `${p.name} (desk)` : p.name));
      opts.push(og);
    }
    return opts;
  };
  fill($("#fromId"), ...groups(ORIGINS));
  fill($("#toId"), ...groups(DESTINATIONS, "Choose a destination…"));
  $("#fromId").value = "kokomlemle";
  $("#toId").value = "kotoka";
}

function buildServices() {
  const base = payload();
  const wrap = $("#services");
  fill(
    wrap,
    ...SERVICES.map((s) => {
      const q = quote({ ...base, service: s.id });
      return h(
        "label",
        { class: "svc", "data-svc": s.id },
        h("input", { type: "radio", name: "service", value: s.id, ...(s.id === "standard" ? { checked: true } : {}) }),
        h("i", {}, s.id === "sameday" ? "FASTEST" : s.id === "express" ? "MOST BOOKED" : "BEST VALUE"),
        h("b", {}, s.label),
        h("p", {}, s.blurb),
        h("span", { class: "amt", "data-amt": s.id }, q.ok ? money(q.total) : "—")
      );
    })
  );
  wrap.addEventListener("change", (e) => {
    if (e.target.name === "service") refresh();
  });
}

function currentService() {
  return form().elements.service?.value || "standard";
}

/** A tier advertises a collection window (`slots`) and the tracker prints it back to
 *  the traveller. The form must not offer a 06:00 pickup on a tier whose window says
 *  09:00 – 18:00, or the manifest would show a promise the booking never made.
 *  Windows outside the tier are disabled and the selection falls back to the first
 *  one the tier can actually service. */
function applyWindows() {
  const svc = SERVICE_BY_ID[currentService()] || SERVICE_BY_ID.standard;
  const [open, close] = svc.slots.split(" – ");
  const sel = $("#pickupWindow");
  for (const opt of sel.options) {
    const [a, b] = opt.value.split(" – ");
    opt.disabled = a < open || b > close; // "HH:MM" compares correctly as text
  }
  const chosen = sel.selectedOptions[0];
  if (!chosen || chosen.disabled) {
    const first = [...sel.options].find((o) => !o.disabled);
    if (first) sel.value = first.value;
  }
  $("#window-note").textContent = `${svc.label} collects ${svc.slots}`;
}

function payload() {
  const f = form();
  const v = (id) => f.elements[id]?.value ?? "";
  return {
    fromId: v("fromId"),
    toId: v("toId"),
    pieces: Number(v("pieces") || 1),
    weightKg: Number(v("weightKg") || 0),
    declaredValue: Number(v("declaredValue") || 0),
    insurance: f.elements.insurance.checked,
    fragile: f.elements.fragile.checked,
    oversize: f.elements.oversize.checked,
    service: f.elements.service?.value || "standard",
    pickupDate: v("pickupDate"),
    pickupWindow: v("pickupWindow"),
    promo: v("promo").trim(),
    customerName: v("customerName"),
    customerPhone: v("customerPhone"),
    customerEmail: v("customerEmail"),
    address: v("address"),
    reference: v("reference"),
    notes: v("notes"),
  };
}

let lastQuote = null;

function refresh() {
  applyWindows(); // may move the selected window, so read the form after it
  const p = payload();
  const q = quote(p);
  const ok = q.ok;
  lastQuote = ok ? q : null;

  // service price tags, relative to what is typed right now
  for (const s of SERVICES) {
    const alt = quote({ ...p, service: s.id });
    const node = $(`[data-amt="${s.id}"]`);
    if (node) node.textContent = alt.ok ? money(alt.total) : "—";
  }
  // scoped to the tier picker: the price panel has an .is-service row too
  $$(".svc", $("#services")).forEach((el) => el.classList.toggle("on", el.dataset.svc === p.service));

  if (!ok) {
    fill($("#price-lines"), h("li", {}, h("span", { class: "muted" }, "Complete the route and weight to see a price.")));
    for (const id of ["t-sub", "t-vat", "t-total"]) $(`#${id}`).textContent = "—";
    $("#row-disc").hidden = true;
    $("#row-weekend").hidden = true;
    $("#sla-note").textContent = q.errors.map((e) => e.message).join(" ");
    fill($("#warns"));
    $("#submit-btn").disabled = true;
    renderLeg(p, null);
    return;
  }

  $("#submit-btn").disabled = false;
  fill(
    $("#price-lines"),
    ...q.lines.map((l) =>
      h("li", { class: l.key === "service" ? "is-service" : "" }, h("span", {}, l.label), h("b", {}, money(l.amount)))
    )
  );
  $("#t-sub").textContent = money(q.subtotal);
  $("#t-vat").textContent = money(q.vat);
  $("#t-total").textContent = money(q.total);
  $("#row-disc").hidden = !q.discount;
  $("#t-disc").textContent = "−" + money(q.discount);
  $("#t-promo").textContent = q.promoLabel || "Discount";
  const weekend = q.lines.find((l) => l.key === "weekend");
  $("#row-weekend").hidden = !weekend;
  if (weekend) $("#t-weekend").textContent = money(weekend.amount);

  const svc = SERVICE_BY_ID[p.service];
  $("#sla-note").replaceChildren();
  $("#sla-note").append(
    h("b", {}, `${svc.label} · `),
    document.createTextNode(
      // the promise wording comes from the same helper that builds the card blurb,
      // so the tier card and the quote line can never state two different times.
      q.sla.pickupScheduled
        ? `collected ${collectWithin(svc.handlingHours)} of ${p.pickupDate} ${p.pickupWindow}, delivered ${q.sla.etaLabel}.`
        : `door-to-door in about ${q.estimate.hours} h once collected.`
    ),
    document.createTextNode(` VAT ${Math.round(CONFIG.vatRate * 100)}% is included. `),
    h("span", { class: "muted" }, `${dash(q.distance.km)} km leg.`)
  );
  fill($("#warns"), ...q.warnings.map((w) => h("li", {}, w)));
  renderLeg(p, q);
}

function renderLeg(p, q) {
  const node = $("#leg-txt");
  if (!q) return void (node.textContent = "Select a route to see the leg.");
  const from = ORIGINS.find((x) => x.id === p.fromId) || DESTINATIONS.find((x) => x.id === p.fromId);
  const to = DESTINATIONS.find((x) => x.id === p.toId);
  if (!to) return void (node.textContent = "Choose a destination to price the leg.");
  const km = legKm(p.fromId, p.toId);
  node.textContent = `${from?.name} → ${to.name} · ${dash(km, 1)} km straight line, ${dash(q.distance.km)} km by road`;
}

async function submit(e) {
  e.preventDefault();
  const btn = $("#submit-btn");
  const p = payload();
  hideErrors();
  btn.disabled = true;
  btn.textContent = "Sending to dispatch…";
  try {
    const s = await api.create(p);
    openConfirm(s);
    toast(`${s.code} booked — the collector calls the night before.`);
    window.dispatchEvent(new CustomEvent("haul:created", { detail: s }));
  } catch (err) {
    showErrors(err.errors?.length ? err.errors : [{ field: "", message: err.message }]);
  } finally {
    btn.disabled = false;
    btn.textContent = "Book this haul";
  }
}

function openConfirm(s) {
  $("#conf-code").textContent = s.code;
  $("#conf-pin").textContent = s.pin;
  $("#conf-lead").textContent =
    `${s.customer.name}, we collect ${s.logistics.pieces} piece(s) · ${s.logistics.weightKg}kg from ${s.from.name} ` +
    `on ${s.pickup.date} (${s.pickup.window}) and hand them over at ${s.to.name}.` +
    (s.reference ? ` Reference: ${s.reference}.` : "");
  $("#conf-total").textContent = money(s.price?.total ?? s.total);
  $("#conf-when").textContent = `${s.pickup.date} · ${s.pickup.window}`;
  const text = encodeURIComponent(
    `BrownHub Haul booking ${s.code}\n${s.from.name} → ${s.to.name}\n${s.logistics.pieces} piece(s), ${s.logistics.weightKg}kg\n` +
      `Collect ${s.pickup.date} ${s.pickup.window}\nTotal GH₵${Number(s.total).toFixed(2)}\nI will share the handover PIN only with the driver.`
  );
  $("#conf-wa").href = `${window.__HAUL_CONTACT?.whatsappLink ?? "https://wa.me/233535583460"}?text=${text}`;
  $("#confirm").hidden = false;
  $("#confirm .x").focus();
}

function closeConfirm() {
  $("#confirm").hidden = true;
  const f = form();
  for (const id of ["customerName", "customerPhone", "customerEmail", "address", "reference", "notes", "promo"]) f.elements[id].value = "";
  refresh();
  f.elements.customerName.focus();
}

function showErrors(errors) {
  const box = $("#book-errors");
  box.hidden = false;
  fill(
    box,
    h("b", {}, "We could not book that yet"),
    h("ul", {}, ...errors.map((e) => h("li", {}, e.message || `${e.field}: invalid`)))
  );
  for (const e of errors) {
    const el = e.field && form().elements[e.field];
    if (el && el.setCustomValidity) el.setCustomValidity(e.message || "Check this");
  }
  box.scrollIntoView({ behavior: "smooth", block: "center" });
}

function hideErrors() {
  $("#book-errors").hidden = true;
  for (const el of $$("input,select,textarea", form())) el.setCustomValidity?.("");
}

export { payload as bookingPayload, lastQuote };
