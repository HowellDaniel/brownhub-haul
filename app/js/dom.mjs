/** Tiny DOM + formatting helpers. No framework on purpose — the depot machine
 *  runs this with nothing installed but Node. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** `html` accepts ONLY literals from this repo (icons, markup skeletons).
 *  Never pass it user, network or storage text — user text goes through
 *  textContent via h()'s children, so injected markup cannot execute. */
const parser = new DOMParser();
function setHTML(el, str) {
  const doc = parser.parseFromString(`<body>${str}</body>`, "text/html");
  for (const n of [...doc.body.childNodes]) el.append(document.importNode(n, true));
}

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "html") setHTML(el, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === false || kid === null || kid === undefined) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const money = (n) => "GH₵" + Number(n).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const dash = (n, d = 0) => Number(n).toLocaleString("en-GH", { maximumFractionDigits: d });

export function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/** Replace a container's children in one paint. */
export function fill(node, ...kids) {
  node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== false && k !== null && k !== undefined));
  return node;
}

export function toast(msg, kind = "ok") {
  const t = h("div", { class: `toast ${kind}`, role: "status" }, msg);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add("in"));
  setTimeout(() => {
    t.classList.remove("in");
    setTimeout(() => t.remove(), 350);
  }, 4200);
}

export const todayISO = () => new Date().toISOString().slice(0, 10);

export function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Downscale a phone photo to a postable JPEG data URL.
 *  A 12 MP camera roll image is 4 MB+ of base64; a custody photo only has to
 *  show that the bag was sealed, so 1280 px at q0.72 is plenty. */
export function shrinkToJpeg(file, { max = 1280, quality = 0.72 } = {}) {
  return new Promise((res, rej) => {
    if (!file?.type?.startsWith("image/")) return void rej(new Error("Not an image"));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        res({ data: c.toDataURL("image/jpeg", quality), width: w, height: h });
      } catch (e) {
        rej(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error("That image could not be read"));
    };
    img.src = url;
  });
}
