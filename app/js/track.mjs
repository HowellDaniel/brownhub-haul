/** Track — the traveller's view of one haul. */

import { $, h, fill, money, dash, when, ago, toast } from "./dom.mjs";
import { api } from "./api.mjs";
import { isValidCode, normalizeCode } from "../../core/codes.mjs";

const ICONS = {
  booked: "1",
  collected: "2",
  in_transit: "3",
  arrived_hub: "4",
  out_for_delivery: "5",
  delivered: "✓",
  delayed: "!",
};

let poll = null;

export function mountTracking(ctx) {
  $("#track-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await lookup($("#track-code").value);
  });
  $("#demo-fill").addEventListener("click", () => {
    $("#track-code").value = "BH-D3MO24";
    lookup("BH-D3MO24");
  });
  if (ctx.code) lookup(ctx.code);
}

export async function lookup(code) {
  const clean = normalizeCode(code);
  $("#track-code").value = clean;
  const out = $("#track-out");
  clearInterval(poll);
  if (!clean) return void fill(out, emptyState("Type a tracking code."));
  if (!isValidCode(clean))
    return void fill(out, h("div", { class: "err-box" }, `“${clean}” is not a BrownHub code. They are BH- then six characters, like BH-D3MO24.`));
  fill(out, h("p", { class: "muted" }, "Finding your bags…"));
  try {
    const s = await api.shipment(clean);
    render(s, out);
    if (s.status !== "delivered") poll = setInterval(() => silentRefresh(clean, out), 45000);
  } catch (e) {
    fill(out, h("div", { class: "err-box" }, e.message));
  }
}

async function silentRefresh(code, out) {
  try {
    const s = await api.shipment(code);
    render(s, out, true);
  } catch {
    /* the traveller keeps the last good view */
  }
}

function emptyState(msg) {
  return h(
    "div",
    { class: "empty" },
    h("div", { html: '<svg viewBox="0 0 24 24"><path fill="#a97c3f" d="M9 2h6v3h4a1 1 0 0 1 1 1v3H3V6a1 1 0 0 1 1-1h5Z"/><rect x="3" y="9" width="18" height="12" rx="2" fill="#e63946" opacity=".85"/><rect x="10" y="13" width="4" height="4" rx="1" fill="#fff" opacity=".7"/></svg>' }),
    h("h2", {}, msg),
    h("p", { class: "muted" }, "Every booking gets a code and a four-digit handover PIN. The PIN is the only proof we accept at the door.")
  );
}

function render(s, out, quiet = false) {
  const order = s.statuses.map((x) => x.key);
  const idx = s.status === "delayed" ? -1 : order.indexOf(s.status);
  const pct = s.status === "delivered" ? 100 : Math.max(6, ((idx + 1) / order.length) * 100);

  const card = h(
    "div",
    { class: "card" },
    h("div", { class: "route-strip" },
      h("b", {}, s.from.name),
      h("div", { html: '<svg class="route" viewBox="0 0 300 24"><line x1="14" y1="12" x2="286" y2="12" stroke="currentColor" stroke-width="2" stroke-dasharray="5 6"/><circle cx="14" cy="12" r="6" fill="#e63946"/><circle cx="286" cy="12" r="6" fill="#a97c3f"/></svg>' }),
      h("b", {}, s.to.name),
      // distance and SLA live inside the quoted price the server stored — not on the row
      h("span", { class: "muted" }, `${dash(s.price?.distance?.km, 1)} km`)
    ),
    h("div", { class: "bar" }, h("i", { style: `width:${pct}%` })),
    timeline(s),
    gallery(s),
    details(s)
  );

  const now = h(
    "div",
    { class: "now-card" },
    h("span", { class: "lbl" }, "Current stage"),
    h("div", { class: "big" }, s.status === "delayed" ? "Delayed" : s.statuses[idx]?.label || s.status),
    h("p", { class: "muted" }, s.status === "delayed" ? latestNote(s) : s.statuses[idx]?.note || ""),
    h("dl", {},
      h("dt", {}, "Code"), h("dd", {}, s.code),
      h("dt", {}, "Pieces"), h("dd", {}, `${s.logistics.pieces} · ${s.logistics.weightKg} kg`),
      h("dt", {}, "Service"), h("dd", {}, s.price?.sla?.label || s.logistics.service),
      h("dt", {}, "Collect"), h("dd", {}, `${s.pickup.date} ${s.pickup.window}`),
      h("dt", {}, "Due"), h("dd", {}, s.price?.sla?.pickupScheduled ? when(s.price.sla.etaISO) : s.price?.sla?.etaLabel || "on the next run"),
      h("dt", {}, "Total"), h("dd", {}, money(s.total))
    ),
    s.driver
      ? h("div", { style: "margin-top:.8rem" },
          h("span", { class: "lbl" }, "Your driver"),
          h("p", {}, `${s.driver.name} · ${s.driver.vehicle}`),
          h("a", { class: "pill", href: `tel:${s.driver.phone.replace(/\s/g, "")}` }, "Call the driver"))
      : h("p", { class: "muted", style: "margin-top:.8rem" }, "A driver is assigned when the leg loads — usually the morning of delivery."),
    pinBox(s)
  );

  fill(out, h("div", { class: "track-card" }, card, now));
  if (!quiet && location.hash.startsWith("#/track")) history.replaceState(null, "", `#/track/${s.code}`);
}

function latestNote(s) {
  const last = s.history[s.history.length - 1];
  return last?.note || "The depot has flagged this leg.";
}

function timeline(s) {
  const order = s.statuses.map((x) => x.key);
  const cur = s.status === "delayed" ? -1 : order.indexOf(s.status);
  const stamped = new Map();
  for (const ev of s.history) if (!stamped.has(ev.status)) stamped.set(ev.status, ev);
  return h(
    "ul",
    { class: "tl" },
    ...s.statuses.map((st, i) => {
      const ev = stamped.get(st.key);
      const done = !!ev && (i <= cur || cur === -1);
      return h(
        "li",
        { class: ev ? (i === cur ? "now" : done ? "done" : "") : "" },
        h("span", { class: "node" }, ICONS[st.key] || "•"),
        h("b", {}, st.label),
        ev ? h("span", { class: "when" }, `${when(ev.at)} · ${ago(ev.at)}`) : h("span", { class: "when muted" }, "pending"),
        h("p", { class: ev ? "" : "muted" }, (ev && ev.note) || st.note)
      );
    }),
    s.status === "delayed"
      ? h("li", { class: "now" },
          h("span", { class: "node" }, "!"),
          h("b", {}, "Delayed"),
          h("span", { class: "when" }, when(s.history[s.history.length - 1]?.at)),
          h("p", {}, latestNote(s)))
      : null
  );
}

/** The collector's photographs, but only when the depot really attached some.
 *  Nothing else on the tracker mentions photos: no stage note promises a picture,
 *  so there is no claim to walk back on a haul that has none. Attach a shot on the
 *  dispatch board and it lands here, stamped with the stage it was taken at. */
function gallery(s) {
  const shots = s.photos || [];
  if (!shots.length) return null;
  return h(
    "div",
    { class: "gallery" },
    h("span", { class: "lbl" }, `Photographed at collection · ${shots.length}`),
    h(
      "div",
      { class: "shots" },
      ...shots.map((p) =>
        h("a", { class: "shot", href: p.url, target: "_blank", rel: "noopener" }, h("img", { src: p.url, alt: p.note || "Custody photo", loading: "lazy" }))
      )
    )
  );
}

function details(s) {
  return h(
    "div",
    { style: "margin-top:1rem;display:flex;flex-wrap:wrap;gap:1.4rem;font-size:.85rem" },
    h("div", {}, h("span", { class: "lbl muted" }, "Collected at"), h("div", {}, s.address || s.from.name)),
    h("div", {}, h("span", { class: "lbl muted" }, "Delivered to"), h("div", {}, s.to.counter || s.to.name)),
    s.reference ? h("div", {}, h("span", { class: "lbl muted" }, "Reference"), h("div", {}, s.reference)) : null,
    s.logistics.notes ? h("div", {}, h("span", { class: "lbl muted" }, "Notes"), h("div", {}, s.logistics.notes)) : null,
    s.logistics.insurance ? h("div", {}, h("span", { class: "lbl muted" }, "Cover"), h("div", {}, `Insured to ${money(s.logistics.declaredValue)}`)) : h("div", {}, h("span", { class: "lbl muted" }, "Cover"), h("div", { class: "muted" }, "Uninsured — default carrier limit")),
    h("div", {}, h("span", { class: "lbl muted" }, "Booked"), h("div", {}, when(s.createdAt)))
  );
}

function pinBox(s) {
  const input = h("input", { type: "text", inputmode: "numeric", maxlength: "4", placeholder: "••••", "aria-label": "Handover PIN" });
  const box = h(
    "div",
    { class: "pinbox" },
    input,
    h(
      "button",
      {
        class: "btn sm",
        onclick: async () => {
          try {
            const r = await api.verifyPin(s.code, input.value);
            toast(r.message, r.ok ? "ok" : "bad");
            if (r.ok) input.value = "";
          } catch (e) {
            toast(e.message, "bad");
          }
        },
      },
      "Check PIN"
    )
  );
  return h("div", {}, h("p", { class: "muted", style: "margin:.9rem 0 0" }, "Driver's check — enter the PIN the traveller gave you:"), box);
}
