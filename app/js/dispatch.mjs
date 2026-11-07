/** Dispatch board — what the depot sees all day.
 *
 *  Every call here carries the depot passphrase (see app/js/api.mjs). A 401 is
 *  not an error to print: it is the state the board starts in, so the board
 *  renders an unlock panel instead of a manifest.
 */

import { $, $$, h, fill, money, dash, when, ago, toast, shrinkToJpeg } from "./dom.mjs";
import { api, auth } from "./api.mjs";

const state = { status: "all", q: "" };
let timer = null;
let locked = false;

export function mountDispatch() {
  $("#board-q").addEventListener("input", (e) => {
    state.q = e.target.value;
    load();
  });
  $("#status-filter").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-status]");
    if (!b) return;
    state.status = b.dataset.status;
    $$("#status-filter button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    await load();
  });
  $("#board").addEventListener("click", onAct);
  $("#board").addEventListener("change", onFile);
  window.addEventListener("haul:created", () => load());
  load();
}

/** The board only polls while it is on screen. */
export function setBoardLive(live) {
  clearInterval(timer);
  timer = null;
  if (live) timer = setInterval(() => load(true), 30000);
}

async function load(quiet = false) {
  try {
    const r = await api.shipments({ status: state.status, q: state.q });
    locked = false;
    renderLockbar();
    if (!quiet) {
      renderStats(r.stats);
      renderFilter(r.statuses, r.stats);
    }
    renderBoard(r);
  } catch (e) {
    if (e.status === 401) {
      locked = true;
      renderLockbar();
      fill($("#stats"));
      fill($("#status-filter"));
      renderLocked();
      return;
    }
    fill($("#board"), h("div", { class: "err-box" }, e.message));
  }
}

/* ————————————————————————— the passphrase ————————————————————————— */

function renderLockbar() {
  fill(
    $("#lockbar"),
    locked
      ? h("span", { class: "lock-state bad" }, h("i", { class: "dot" }), "Locked — the manifest needs the depot passphrase")
      : h("span", { class: "lock-state ok" }, h("i", { class: "dot live" }), "Unlocked for this shift"),
    locked
      ? null
      : h(
          "button",
          {
            class: "btn sm ghost",
            onclick: () => {
              auth.lock();
              load();
              toast("Board locked. Close the tab and it stays locked.");
            },
          },
          "Lock the board"
        )
  );
}

function renderLocked(msg = "") {
  const input = h("input", { type: "password", id: "unlock-token", autocomplete: "current-password", placeholder: "BHDEPOT-…", "aria-label": "Depot passphrase" });
  const panel = h(
    "div",
    { class: "lock-panel" },
    h("h2", {}, "Dispatch is locked"),
    h(
      "p",
      { class: "muted" },
      "The manifest carries names, door addresses and handover PINs, so it is not served to a browser that cannot prove it belongs to the depot. The passphrase is printed on the server's first boot and never stored in plain text."
    ),
    h(
      "form",
      {
        class: "unlock",
        onsubmit: async (e) => {
          e.preventDefault();
          const btn = $("button", e.target);
          btn.disabled = true;
          auth.unlock(input.value);
          await load();
          if (!locked) {
            toast("Dispatch unlocked.");
            input.value = "";
          } else {
            auth.lock();
            renderLocked("That passphrase was refused.");
          }
          btn.disabled = false;
        },
      },
      input,
      h("button", { class: "btn primary", type: "submit" }, "Unlock")
    ),
    msg ? h("p", { class: "err-box", style: "margin-top:.6rem" }, msg) : null
  );
  fill($("#board"), panel);
  input.focus();
}

/* ————————————————————————— board ————————————————————————— */

function renderStats(s) {
  fill(
    $("#stats"),
    stat("Open hauls", dash(s.open), true),
    stat("Delivered", dash(s.delivered)),
    stat("Delayed", dash(s.delayed), s.delayed > 0),
    stat("Pipeline value", money(s.pipelineValue)),
    stat("Pieces moved", dash(s.pieces)),
    stat("Weight moved", `${dash(s.kg)} kg`),
    stat("Custody photos", dash(s.photos ?? 0))
  );
}

const stat = (label, value, hot = false) =>
  h("div", { class: `stat${hot ? " hot" : ""}` }, h("span", {}, label), h("b", {}, value));

function renderFilter(statuses, stats) {
  fill(
    $("#status-filter"),
    h("button", { type: "button", "data-status": "all", "aria-pressed": state.status === "all" }, `All (${stats.total})`),
    ...statuses.map((st) =>
      h("button", { type: "button", "data-status": st.key, "aria-pressed": state.status === st.key }, st.label)
    ),
    h("button", { type: "button", "data-status": "delayed", "aria-pressed": state.status === "delayed" }, "Delayed")
  );
}

function renderBoard(r) {
  if (!r.shipments.length) {
    return void fill(
      $("#board"),
      h("div", { class: "empty" }, h("h2", {}, "Nothing on the manifest"), h("p", { class: "muted" }, "No haul matches this filter."))
    );
  }
  fill($("#board"), ...r.shipments.map((s) => row(s, r.statuses)));
}

function row(s, statuses) {
  const cur = statuses.findIndex((x) => x.key === s.status);
  const next = s.status === "delayed" ? null : statuses[cur + 1];
  const badge = h(
    "span",
    { class: `badge b-${s.status}` },
    h("i", { class: "dot", style: s.status === "delayed" ? "background:#b26a00" : "" }),
    s.status === "delayed" ? "Delayed" : statuses[cur]?.label || s.status
  );

  const acts = h(
    "div",
    { class: "acts" },
    badge,
    h("button", { class: "btn sm ghost", "data-act": "toggle" }, "Details"),
    next
      ? h("button", { class: "btn sm primary", "data-act": "advance", "data-code": s.code }, `→ ${next.label}`)
      : h("button", { class: "btn sm", "data-act": "advance", "data-code": s.code, disabled: true }, "Complete"),
    s.status !== "delivered" && s.status !== "delayed"
      ? h("button", { class: "btn sm", "data-act": "delay", "data-code": s.code, title: "Flag a delay" }, "Delay")
      : s.status === "delayed"
      ? h("button", { class: "btn sm", "data-act": "resume", "data-code": s.code }, "Resume")
      : null
  );

  const detail = h(
    "div",
    { class: "row-detail" },
    h(
      "div",
      { class: "kv" },
      kv("Route", `${s.from.name} → ${s.to.name}`),
      kv("Address", s.address || "—"),
      kv("Load", `${s.logistics.pieces} pc · ${s.logistics.weightKg} kg · ${s.logistics.service}`),
      kv("Cover", s.logistics.insurance ? money(s.logistics.declaredValue) : "none"),
      kv("Handover PIN", s.pin),
      kv("Driver", s.driver ? `${s.driver.name} · ${s.driver.vehicle}` : "unassigned"),
      kv("Total", money(s.total))
    ),
    s.logistics.notes ? h("p", {}, h("b", {}, "Notes: "), s.logistics.notes) : null,
    photoBox(s),
    h(
      "ol",
      { style: "margin:.4rem 0 0;padding-left:1.1rem;font-size:.82rem;color:var(--ink-3)" },
      ...s.history.map((e) => h("li", {}, `${when(e.at)} · ${e.by}: ${e.note}`))
    )
  );

  return h(
    "article",
    { class: "row", "data-code": s.code },
    h("div", { class: "who" }, h("b", {}, s.customer.name), h("div", { class: "code" }, s.code), h("p", {}, s.customer.phone)),
    h("div", { class: "leg" }, `${s.from.name} → ${s.to.name}`, h("small", {}, `${s.pickup.date} ${s.pickup.window} · booked ${ago(s.createdAt)}`)),
    acts,
    detail
  );
}

const kv = (k, v) => h("div", {}, h("span", {}, k), h("b", {}, String(v)));

/** The collector's camera. One control per haul: pick the shot, it is resized in
 *  the page and posted, and the tracker picks it up on its next refresh. */
function photoBox(s) {
  const shots = (s.photos || []).map((p) =>
    h("a", { class: "shot", href: p.url, target: "_blank", rel: "noopener" }, h("img", { src: p.url, alt: p.note || "Custody photo", loading: "lazy" }))
  );
  return h(
    "div",
    { class: "photos" },
    h("div", { class: "shots" }, ...shots),
    h(
      "label",
      { class: "shoot" },
      h("input", { type: "file", accept: "image/*", capture: "environment", "data-photo": s.code, multiple: "" }),
      h("span", {}, shots.length ? "Add another photo" : "Photograph the seal")
    )
  );
}

async function onFile(e) {
  const input = e.target.closest("input[data-photo]");
  if (!input) return;
  const code = input.dataset.photo;
  const files = [...input.files].slice(0, 4);
  input.value = "";
  if (!files.length) return;
  const btn = $("span", input.parentElement);
  btn.textContent = "Sending…";
  let sent = 0;
  try {
    for (const f of files) {
      const { data } = await shrinkToJpeg(f);
      await api.photo(code, data, f.name.slice(0, 60));
      sent += 1;
    }
    toast(`${code}: ${sent} custody photo${sent === 1 ? "" : "s"} on the tracker.`);
    await load(); // a full reload: the photos tile has to move the moment a shot lands
    const opened = $(`.row[data-code="${code}"]`);
    if (opened) opened.classList.add("open"); // and the desk keeps looking at the haul they just photographed
  } catch (err) {
    toast(err.message, "bad");
  }
  btn.textContent = sent ? "Add another photo" : "Photograph the seal";
}

async function onAct(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const rowEl = btn.closest(".row");
  const code = rowEl.dataset.code;
  const act = btn.dataset.act;

  if (act === "toggle") return void rowEl.classList.toggle("open");

  btn.disabled = true;
  try {
    if (act === "advance") {
      const r = await api.advance(code, { by: "board" });
      toast(`${code} → ${r.shipment.status.replace("_", " ")}`);
    } else if (act === "delay") {
      const reason = window.prompt(`Why is ${code} late? The traveller sees this on the tracker.`, "Traffic on the N1 — new ETA in 2 hours.");
      if (!reason) {
        btn.disabled = false; // a cancelled prompt is not an action — the button must come back
        return;
      }
      await api.exception(code, reason);
      toast(`${code} flagged as delayed.`, "bad");
    } else if (act === "resume") {
      await api.advance(code, { note: "Back on the manifest.", by: "board" });
      toast(`${code} resumed.`);
    }
    const wasOpen = rowEl.classList.contains("open");
    await load(); // full reload: the stats tiles describe the manifest we just changed
    if (wasOpen) $(`.row[data-code="${code}"]`)?.classList.add("open");
  } catch (err) {
    if (err.status === 401) return void load(); // the passphrase was rotated mid-shift
    toast(err.message, "bad");
    btn.disabled = false;
  }
}

export function unmountDispatch() {
  clearInterval(timer);
  timer = null;
}
