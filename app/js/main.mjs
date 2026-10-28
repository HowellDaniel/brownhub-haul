/** Boot + hash router. Three views, one page, no framework. */

import { $, $$, fill, h } from "./dom.mjs";
import { api } from "./api.mjs";
import { mountBooking } from "./booking.mjs";
import { mountTracking, lookup } from "./track.mjs";
import { mountDispatch, setBoardLive } from "./dispatch.mjs";
import { installPWA, registerShell } from "./install.mjs";

const VIEWS = { book: "#view-book", track: "#view-track", dispatch: "#view-dispatch" };
const mounted = new Set();
let places = null;

export async function boot() {
  $("#year").textContent = String(new Date().getFullYear());
  let config;
  try {
    [config, places] = await Promise.all([api.config(), api.places()]);
  } catch (e) {
    $("#offline").hidden = false;
    $("#api-host").textContent = location.origin;
    console.error("[haul] engine unreachable:", e);
    return;
  }
  window.__HAUL = config;
  window.__HAUL_CONTACT = config.contact;
  paintChrome(config);
  mount("book", () => mountBooking(config));
  route();
  window.addEventListener("hashchange", route);
  window.addEventListener("haul:track", (e) => {
    location.hash = `#/track/${e.detail}`;
  });
}

function mount(name, fn) {
  if (mounted.has(name)) return;
  mounted.add(name);
  fn();
}

function paintChrome(c) {
  const ct = c.contact;
  paintStudio(c);
  $("#wa-top").href = `${ct.whatsappLink}?text=${encodeURIComponent("Hi BrownHub Haul — I need my luggage moved.")}`;
  $("#call-top").href = ct.phoneLink;
  $("#wa-inline").href = `${ct.whatsappLink}?text=${encodeURIComponent("Hi BrownHub Haul — urgent collection, within two hours.")}`;
  $("#hero-window").textContent = ct.hours.split("·")[0].trim();
  $("#foot-depot").replaceChildren(
    h("span", {}, ct.depot.name),
    h("br"),
    h("a", { href: ct.depot.maps, target: "_blank", rel: "noopener" }, ct.depot.address),
    h("br"),
    h("a", { href: ct.counter.maps, target: "_blank", rel: "noopener" }, ct.counter.name + " · " + ct.counter.address)
  );
  $("#foot-contact").replaceChildren(
    h("a", { href: `${ct.whatsappLink}`, target: "_blank", rel: "noopener" }, `WhatsApp ${ct.whatsapp.replace(/(\d{3})(\d{3})(\d+)/, "$1 $2 $3")}`),
    h("br"),
    h("a", { href: ct.phoneLink }, `Call ${ct.phone}`),
    h("br"),
    h("a", { href: `mailto:${ct.email}` }, ct.email)
  );
  $("#foot-hours").textContent = ct.hours;
}

/** The parent brand: Haul is an app of BrownHub Studio, so the strip, the footer
 *  and the document title all name the studio and link back to its site. Every
 *  value here came from the studio's own pages via /api/config — nothing about
 *  the studio is typed into this file. */
function paintStudio(c) {
  const st = c.contact?.studio || {};
  const attribution = c.brand?.attribution || st.attribution || "An app by BrownHub Studio";
  const site = st.site || "https://www.brownhub283.com/";
  let host = "";
  try { host = new URL(site).host.replace(/^www\./, ""); } catch { /* keep the default */ }

  const link = $("#studio-link");
  if (link) {
    link.href = site;
    if (st.descriptor) link.title = `${st.name || "BrownHub Studio"} — ${st.descriptor}`;
    $("#studio-attribution").textContent = attribution;
    $("#studio-host").textContent = host;
  }
  const services = $("#studio-services");
  if (services) {
    try { services.href = new URL("services.html", site).href; } catch { /* leave the literal */ }
  }
  const brand = $("#foot-brand");
  if (brand) brand.href = site;
  const footAttr = $("#foot-attribution");
  if (footAttr) footAttr.textContent = attribution;
  const parent = $("#copy-parent");
  if (parent) parent.textContent = st.name || "BrownHub Studio";

  const studio = $("#foot-studio");
  if (studio) {
    const rows = [];
    if (st.name) rows.push(h("a", { href: site, target: "_blank", rel: "noopener" }, h("strong", {}, st.name)));
    if (st.address) rows.push(h("span", {}, st.address));
    if (st.email) rows.push(h("a", { href: `mailto:${st.email}` }, st.email));
    studio.replaceChildren(...rows.flatMap((r, i) => (i ? [h("br"), r] : [r])));
  }
  document.title = `${c.contact?.brand || "BrownHub Haul"} — ${attribution}`;
}

function route() {
  const [, name = "book", arg = ""] = location.hash.split("/");
  const view = VIEWS[name] ? name : "book";
  for (const [key, sel] of Object.entries(VIEWS)) $(sel).hidden = key !== view;
  $$("#tabs a").forEach((a) => {
    const on = a.dataset.tab === view;
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (view === "dispatch") mount("dispatch", () => mountDispatch());
  setBoardLive(view === "dispatch");
  if (view === "track") {
    mount("track", () => mountTracking({ code: arg || "" }));
    if (arg) lookup(decodeURIComponent(arg));
  }
  window.scrollTo({ top: 0 });
  if (!location.hash) location.replace("#/book");
}

document.addEventListener("DOMContentLoaded", boot);
installPWA(); // the module runs after the shell is parsed, so the button exists
registerShell();
