import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { session } from "./cdp.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const scratch = await mkdtemp(join(tmpdir(), "haul-account-ui-"));
const port = 8814;
const cdpPort = 9414;
const base = `http://127.0.0.1:${port}`;
const password = "browser-test-password";
let server;
let chrome;
let s;
let checks = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, value, detail) {
  checks++;
  assert.ok(value, `${name}: ${JSON.stringify(detail)}`);
  console.log(`ok ${checks} — ${name}`);
}

async function waitFor(expression, label) {
  for (let i = 0; i < 80; i++) {
    try { if (await s.eval(expression)) return; } catch {}
    await sleep(100);
  }
  throw new Error(`timed out: ${label}`);
}

try {
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DB: join(scratch, "shipments.json"), BROWN_OFFLINE: "1", HAUL_TOKEN: "test-only-depot-token" },
    stdio: "ignore",
    detached: true,
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await sleep(75);
  }
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${join(scratch, "chrome")}`,
    "--window-size=1280,900", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
  ], { stdio: "ignore", detached: true });
  s = await session(cdpPort);
  await s.setSize(1280, 900);
  await s.navigate(`${base}/#/book`);
  await waitFor(`document.querySelectorAll('#services .svc').length === 3`, "booking form");

  check("navigation exposes sign-up and login", await s.eval(`!!document.querySelector('#signup-open') && !!document.querySelector('#login-open')`));
  check("the landing page includes three real Ghana airport cards", await s.eval(`document.querySelectorAll('.airport-card').length === 3 && !!document.querySelector('img[src*="kumasi-airport"]') && !!document.querySelector('img[src*="tamale-airport"]')`));
  check("terminal studies are labelled as illustrations", await s.eval(`document.querySelectorAll('.terminal-scene').length === 3 && [...document.querySelectorAll('.terminal-scene')].every(e => /illustrated/i.test(e.getAttribute('aria-label') || ''))`));
  check("the motion module is part of the shell", await s.eval(`!!document.querySelector('script[src="app/js/motion.mjs"]')`));
  await s.eval(`document.querySelector('#airports').scrollIntoView(); true`);
  await waitFor(`document.querySelectorAll('[data-reveal].is-visible').length >= 2`, "scroll reveals");
  check("scrolling reveals editorial sections", await s.eval(`document.querySelectorAll('[data-reveal].is-visible').length >= 2`));
  await s.eval(`window.scrollTo({top: 0, behavior: 'instant'}); true`);
  await s.click("#signup-open");
  await waitFor(`!document.querySelector('#account-modal').hidden`, "sign-up dialog");
  await s.type("#signup-name", "Browser Traveller");
  await s.type("#signup-email", "browser@example.com");
  await s.type("#signup-phone", "+233 53 558 3460");
  await s.type("#signup-password", password);
  await s.click("#signup-submit");
  await waitFor(`!document.querySelector('#account-home').hidden`, "signed-in account");
  check("sign-up shows the traveller account", /Browser Traveller/.test(await s.eval(`document.querySelector('#account-name').textContent`)));

  await s.click("#account-close");
  check("account details prefill the booking form", (await s.eval(`document.querySelector('#customerName').value`)) === "Browser Traveller" && (await s.eval(`document.querySelector('#customerEmail').value`)) === "browser@example.com");
  await s.click("#submit-btn");
  await waitFor(`!document.querySelector('#confirm').hidden`, "booking confirmation");
  const code = await s.eval(`document.querySelector('#conf-code').textContent`);
  const pin = await s.eval(`document.querySelector('#conf-pin').textContent`);
  check("confirmation explains the local email delivery warning", await s.eval(`(() => { const e = document.querySelector('#conf-email'); return e && !e.hidden && /confirmed/i.test(e.textContent) && e.classList.contains('is-warning'); })()`));
  await s.click("#confirm [data-close]");
  await s.click("#account-open");
  await waitFor(`!document.querySelector('#account-modal').hidden`, "booking history");
  check("new booking is listed in My bookings", (await s.eval(`document.querySelector('#booking-history').textContent`)).includes(code));

  await s.click("#logout-btn");
  await waitFor(`document.querySelector('#account-home').hidden`, "logged-out dialog");
  check("logout restores navigation login controls", await s.eval(`!document.querySelector('#login-open').hidden && !document.querySelector('#signup-open').hidden`));
  await s.click("#account-close");
  await s.type("#customerName", "Guest Receipt");
  await s.type("#customerPhone", "+233 53 558 3460");
  await s.type("#customerEmail", "");
  await s.click("#submit-btn");
  await waitFor(`!document.querySelector('#confirm').hidden`, "guest booking confirmation");
  check("a booking without email explains that no receipt was requested", await s.eval(`(() => { const e = document.querySelector('#conf-email'); return e && !e.hidden && /email address/i.test(e.textContent) && !e.classList.contains('is-warning'); })()`));
  await s.click("#confirm [data-close]");
  await s.click("#login-open");
  await s.click("#login-tab");
  await s.type("#login-email", "browser@example.com");
  await s.type("#login-password", password);
  await s.click("#login-submit");
  await waitFor(`!document.querySelector('#account-home').hidden`, "logged-in account");
  check("the booking survives logout and login in the browser", (await s.eval(`document.querySelector('#booking-history').textContent`)).includes(code));
  check("no account, contact or handover secrets are cached in localStorage", await s.eval(`!Object.values(localStorage).some(v => v.includes(${JSON.stringify(code)}) || v.includes(${JSON.stringify(password)}) || v.includes(${JSON.stringify(pin)}) || v.includes('browser@example.com') || /pinSeal|haul_session/.test(v))`));

  console.log(`\n${checks} account browser checks passed`);
} finally {
  s?.conn?.close?.();
  for (const p of [chrome, server]) {
    if (!p?.pid) continue;
    try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} }
  }
  await sleep(250);
  await rm(scratch, { recursive: true, force: true });
}
