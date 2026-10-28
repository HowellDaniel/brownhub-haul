/** Install — the two platforms install a web app in two different ways, and the
 *  page must not pretend otherwise.
 *
 *  Android / desktop Chrome: `beforeinstallprompt` is held and replayed on the
 *  button, so the install is the browser's own dialog.
 *  iPhone / iPad: Safari has no prompt event. The button opens the Share-sheet
 *  recipe, and on a non-Safari iOS browser it says to switch to Safari first
 *  (Chrome on iOS cannot add to the home screen).
 *
 *  If the browser supports neither, the button stays hidden — a dead button is
 *  worse than no button. */

import { $, h, toast } from "./dom.mjs";

const standalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  window.matchMedia("(display-mode: fullscreen)").matches ||
  navigator.standalone === true;

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** Any iOS browser that is not Safari — every one of them is WebKit, but only
 *  Safari exposes "Add to Home Screen". Chrome iOS still carries Safari/ in its
 *  UA, so match the browser token, not the absence of Safari. */
const isIOSNonSafari = () => isIOS() && /CriOS|FxiOS|EdgiOS|OPiOS|mercury/i.test(navigator.userAgent);

export function installPWA() {
  const btn = $("#install-app");
  if (!btn) return;
  if (standalone()) {
    btn.hidden = true;
    return;
  }

  const sheet = $("#install-sheet");
  const steps = $("#install-steps");
  const lead = $("#install-lead");
  const note = $("#install-note");
  let prompt = null;

  const close = () => {
    if (sheet) sheet.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
  const openSheet = () => {
    if (!sheet) return;
    const ios = isIOS();
    const recipe = ios
      ? [
          "Tap the Share button (the square with an arrow) in Safari's toolbar.",
          "Scroll the sheet and tap Add to Home Screen.",
          "Tap Add — Haul opens from your home screen like any other app.",
        ]
      : [
          "Open the browser menu (⋮ or ⋯).",
          "Choose Install app or Add to Home screen.",
          "Confirm — Haul opens in its own window, without the address bar.",
        ];
    if (lead) {
      lead.textContent = ios && isIOSNonSafari()
        ? "Open this page in Safari first. On iPhone and iPad only Safari can add an app to the home screen."
        : ios
          ? "Safari keeps Haul on your home screen, one tap away, with no address bar and no app store."
          : "Install Haul from your browser — it then opens like an app, even with no connection.";
    }
    if (steps) steps.replaceChildren(...recipe.map((line) => h("li", {}, line)));
    if (note) {
      note.textContent = ios
        ? "Already installed? It is named BrownHub Haul on your home screen."
        : "Chrome, Edge and Samsung Internet show the install option; Firefox does not install web apps.";
    }
    sheet.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    $("#install-close")?.focus();
  };

  btn.addEventListener("click", async () => {
    if (prompt) {
      prompt.prompt();
      const { outcome } = await prompt.userChoice;
      prompt = null;
      if (outcome === "accepted") {
        btn.hidden = true;
        toast("BrownHub Haul is on your home screen.", "ok");
      }
      return;
    }
    // iPhone has no prompt event — and a browser that has one may have spent it.
    openSheet();
  });

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    prompt = e;
    btn.hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    prompt = null;
    btn.hidden = true;
    close();
    toast("BrownHub Haul is on your home screen.", "ok");
  });

  $("#install-close")?.addEventListener("click", close);
  sheet?.addEventListener("click", (e) => {
    if (e.target === sheet) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheet && !sheet.hidden) close();
  });

  // iOS never fires beforeinstallprompt; the button is the only entry point.
  if (isIOS()) btn.hidden = false;
}

/** Register the shell worker. Only in a secure context: on a LAN IP over plain
 *  HTTP the browser refuses service workers, and the app still works online. */
export function registerShell() {
  if (!("serviceWorker" in navigator)) return;
  const secure = location.protocol === "https:" || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (!secure) return;

  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
      reg.addEventListener("updatefound", () => {
        const next = reg.installing;
        next?.addEventListener("statechange", () => {
          if (next.state === "installed" && navigator.serviceWorker.controller) {
            toast("A new version of Haul is ready — reopen the app to use it.", "ok");
          }
        });
      });
    } catch (e) {
      // A missing worker must never stop a booking; the app is still fully online.
      console.warn("[haul] service worker not registered:", e.message);
    }
  });
}
