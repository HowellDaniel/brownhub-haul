import { $, $$, h, fill, money, toast } from "./dom.mjs";
import { api } from "./api.mjs";

let currentAccount = null;
let lastFocus = null;

export function mountAccounts() {
  $("#login-open").addEventListener("click", () => openDialog("login"));
  $("#signup-open").addEventListener("click", () => openDialog("signup"));
  $("#account-open").addEventListener("click", async () => {
    await refreshAccount();
    openDialog();
  });
  $("#account-close").addEventListener("click", closeDialog);
  $("#account-modal").addEventListener("click", (e) => {
    if (e.target === $("#account-modal")) closeDialog();
  });
  $("#login-tab").addEventListener("click", () => selectTab("login"));
  $("#signup-tab").addEventListener("click", () => selectTab("signup"));
  $(".account-tabs").addEventListener("keydown", onTabKey);
  $("#login-panel").addEventListener("submit", (e) => submitAuth(e, "login"));
  $("#signup-panel").addEventListener("submit", (e) => submitAuth(e, "signup"));
  $("#logout-btn").addEventListener("click", logout);
  $("#account-book").addEventListener("click", () => {
    closeDialog();
    location.hash = "#/book";
    $("#book-form").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
  document.addEventListener("keydown", onDialogKey);
  window.addEventListener("haul:created", () => {
    if (currentAccount) refreshAccount();
  });
  refreshAccount();
}

async function refreshAccount() {
  try {
    const result = await api.account();
    setAccount(result.account, result.bookings);
    return result;
  } catch (e) {
    if (!$("#account-modal").hidden) showStatus(e.message);
    return null;
  }
}

function setAccount(account, bookings = []) {
  currentAccount = account || null;
  $("#account-auth").hidden = !!currentAccount;
  $("#account-home").hidden = !currentAccount;
  $("#login-open").hidden = !!currentAccount;
  $("#signup-open").hidden = !!currentAccount;
  $("#account-open").hidden = !currentAccount;
  hideStatus();

  if (currentAccount) {
    $("#account-name").textContent = currentAccount.name;
    $("#account-email").textContent = currentAccount.email;
    $(".account-avatar").textContent = currentAccount.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
    renderHistory(bookings);
  }
  window.dispatchEvent(new CustomEvent("haul:account", { detail: currentAccount }));
}

function renderHistory(bookings) {
  const list = $("#booking-history");
  if (!bookings.length) {
    fill(list, h("div", { class: "history-empty" }, h("strong", {}, "No bookings yet"), h("p", {}, "Your next confirmed haul will appear here.")));
    return;
  }
  fill(list, ...bookings.map((booking) => {
    const status = String(booking.status || "booked").replaceAll("_", " ");
    return h("article", { class: "history-item" },
      h("div", { class: "history-top" },
        h("div", {}, h("span", { class: "history-label" }, "Tracking code"), h("strong", {}, booking.code)),
        h("span", { class: `badge b-${booking.status}` }, status)
      ),
      h("p", { class: "history-route" }, `${booking.from.name} → ${booking.to.name}`),
      h("div", { class: "history-meta" },
        h("span", {}, `${booking.pickup.date} · ${booking.pickup.window}`),
        h("strong", {}, money(booking.total))
      ),
      h("a", { class: "history-track", href: `#/track/${encodeURIComponent(booking.code)}`, onclick: closeDialog }, "Track this haul →")
    );
  }));
}

async function submitAuth(event, mode) {
  event.preventDefault();
  const login = mode === "login";
  const button = $(login ? "#login-submit" : "#signup-submit");
  const payload = login ? {
    email: $("#login-email").value,
    password: $("#login-password").value,
  } : {
    name: $("#signup-name").value,
    email: $("#signup-email").value,
    phone: $("#signup-phone").value,
    password: $("#signup-password").value,
  };
  button.disabled = true;
  const label = button.textContent;
  button.textContent = login ? "Logging in…" : "Creating your account…";
  hideStatus();
  try {
    const result = login ? await api.login(payload) : await api.signup(payload);
    setAccount(result.account, result.bookings);
    $("#login-password").value = "";
    $("#signup-password").value = "";
    toast(login ? "Welcome back — your bookings are here." : "Your Haul account is ready.");
    $("#account-close").focus();
  } catch (e) {
    showStatus(e.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function logout() {
  const button = $("#logout-btn");
  button.disabled = true;
  try {
    await api.logout();
    setAccount(null);
    selectTab("login");
    $("#login-email").focus();
    toast("Logged out. Your bookings remain saved to your account.");
  } catch (e) {
    showStatus(e.message);
  } finally {
    button.disabled = false;
  }
}

function openDialog(tab) {
  lastFocus = document.activeElement;
  if (tab) selectTab(tab);
  $("#account-modal").hidden = false;
  document.body.classList.add("modal-open");
  const target = currentAccount ? $("#account-close") : $(tab === "signup" ? "#signup-name" : "#login-email");
  target.focus();
}

function closeDialog() {
  $("#account-modal").hidden = true;
  document.body.classList.remove("modal-open");
  if (lastFocus?.isConnected) lastFocus.focus();
}

function selectTab(tab) {
  const login = tab === "login";
  for (const name of ["login", "signup"]) {
    const active = name === tab;
    $(`#${name}-tab`).setAttribute("aria-selected", String(active));
    $(`#${name}-tab`).tabIndex = active ? 0 : -1;
    $(`#${name}-panel`).hidden = !active;
  }
  hideStatus();
  if (!$("#account-modal").hidden) $(login ? "#login-email" : "#signup-name").focus();
}

function onTabKey(event) {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  const next = $("#login-tab").getAttribute("aria-selected") === "true" ? "signup" : "login";
  selectTab(next);
  $(`#${next}-tab`).focus();
}

function onDialogKey(event) {
  if ($("#account-modal").hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeDialog();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = $$("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex='0']", $("#account-modal"))
    .filter((el) => el.getClientRects().length && !el.closest("[hidden]"));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function showStatus(message) {
  const status = $("#account-status");
  status.textContent = message;
  status.hidden = false;
}

function hideStatus() {
  $("#account-status").hidden = true;
  $("#account-status").textContent = "";
}
