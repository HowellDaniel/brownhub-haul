import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { session } from "./cdp.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const scratch = await mkdtemp(join(tmpdir(), "haul-login-offline-"));
const port = 8816;
const cdpPort = 9416;
const base = `http://127.0.0.1:${port}`;
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
  for (let i = 0; i < 100; i++) {
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

  const unavailable = { ok: false, error: "account unavailable", message: "Account service is temporarily unavailable." };
  await s.raw("Fetch.enable", {
    patterns: [
      { urlPattern: `${base}/api/config`, requestStage: "Request" },
      { urlPattern: `${base}/api/places`, requestStage: "Request" },
      { urlPattern: `${base}/api/account/login`, requestStage: "Request" },
    ],
  });
  s.conn.on("Fetch.requestPaused", async ({ requestId, request }) => {
    try {
      if (request.url.endsWith("/api/account/login")) {
        await s.raw("Fetch.fulfillRequest", {
          requestId,
          responseCode: 503,
          responseHeaders: [{ name: "content-type", value: "application/json" }],
          body: Buffer.from(JSON.stringify(unavailable)).toString("base64"),
        });
      } else {
        await s.raw("Fetch.failRequest", { requestId, errorReason: "Failed" });
      }
    } catch {}
  });

  await s.navigate(`${base}/#/book`);
  await waitFor(`!document.querySelector('#offline').hidden`, "offline booking notice");
  check("booking configuration failure is visible", await s.eval(`!document.querySelector('#offline').hidden`));
  check("booking controls stay unavailable", await s.eval(`document.querySelectorAll('#services .svc').length === 0`));

  await s.click("#login-open");
  await waitFor(`!document.querySelector('#account-modal').hidden`, "login dialog while booking engine is unavailable");
  check("login opens during booking configuration failure", await s.eval(`!document.querySelector('#account-modal').hidden`));
  check("the login form is operable", await s.eval(`!document.querySelector('#login-submit').disabled && !!document.querySelector('#login-email')`));

  await s.type("#login-email", "traveller@example.test");
  await s.type("#login-password", "not-a-real-password");
  await s.click("#login-submit");
  await waitFor(`!document.querySelector('#account-status').hidden`, "account error status");
  check("account failure is shown in the dialog", (await s.eval(`document.querySelector('#account-status').textContent`)).includes(unavailable.message));

  await s.click("#account-close");
  await s.click("#signup-open");
  await waitFor(`!document.querySelector('#account-modal').hidden && !document.querySelector('#signup-panel').hidden`, "sign-up dialog while offline");
  check("sign-up also opens during booking configuration failure", await s.eval(`!document.querySelector('#signup-panel').hidden`));

  console.log(`\n${checks} offline login checks passed`);
} finally {
  s?.conn?.close?.();
  for (const p of [chrome, server]) {
    if (!p?.pid) continue;
    try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} }
  }
  await sleep(250);
  await rm(scratch, { recursive: true, force: true });
}