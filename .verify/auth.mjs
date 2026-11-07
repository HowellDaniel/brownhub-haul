import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const NODE = process.execPath;
const scratch = await mkdtemp(join(tmpdir(), "haul-auth-"));
const db = join(scratch, "shipments.json");
const port = 9400 + (process.pid % 500);
const base = `http://127.0.0.1:${port}`;
let child;
let checks = 0;

function check(name, condition, detail) {
  checks++;
  assert.ok(condition, `${name}: ${JSON.stringify(detail)}`);
  console.log(`ok ${checks} — ${name}`);
}

async function start() {
  child = spawn(NODE, ["server.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DB: db, BROWN_OFFLINE: "1", HAUL_TOKEN: "test-only-depot-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => { output += b; });
  child.stderr.on("data", (b) => { output += b; });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {}
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server did not start: ${output}`);
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await done;
}

function client() {
  let cookie = "";
  return {
    get cookie() { return cookie; },
    async call(method, path, body) {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      const data = await res.json();
      return { res, data, set };
    },
  };
}

const booking = {
  customerName: "Ama Account", customerPhone: "+233 53 558 3460", customerEmail: "ama@example.com",
  fromId: "kokomlemle", toId: "kotoka", pickupDate: "2026-11-10", pickupWindow: "10:00 – 12:00",
  pieces: 2, weightKg: 22, declaredValue: 4000, service: "standard", insurance: true,
};

try {
  await start();
  const ama = client();
  const other = client();

  let r = await ama.call("GET", "/api/account");
  check("signed-out account state is empty", r.res.status === 200 && r.data.account === null && r.data.bookings.length === 0, r.data);

  r = await ama.call("POST", "/api/account/signup", { name: "Ama Account", email: "ama@example.com", password: "short" });
  check("weak passwords are refused", r.res.status === 422, r.data);

  r = await ama.call("POST", "/api/account/signup", { name: "Ama Account", email: "Ama@Example.com", phone: "+233 53 558 3460", password: "a-long-test-password" });
  check("sign-up creates a session", r.res.status === 201 && r.data.account.email === "ama@example.com", r.data);
  check("session cookie is HttpOnly, scoped and SameSite", /HttpOnly/i.test(r.set) && /Path=\//i.test(r.set) && /SameSite=Lax/i.test(r.set), r.set);
  check("account responses do not expose password material", !("password" in r.data.account) && !("passwordHash" in r.data.account), r.data.account);

  r = await ama.call("POST", "/api/shipments", booking);
  check("a signed-in booking is accepted", r.res.status === 201, r.data);
  const code = r.data.code;
  check("public booking response hides ownership internals", !("accountId" in r.data) && !("pinSeal" in r.data), r.data);

  r = await ama.call("GET", "/api/account");
  check("booking appears in account history", r.data.bookings.length === 1 && r.data.bookings[0].code === code, r.data);
  check("account history never exposes a PIN or ownership internals", !("pin" in r.data.bookings[0]) && !("pinSeal" in r.data.bookings[0]) && !("accountId" in r.data.bookings[0]), r.data.bookings[0]);

  r = await other.call("POST", "/api/account/signup", { name: "Other Traveller", email: "other@example.com", password: "another-long-password" });
  check("a second account can sign up", r.res.status === 201, r.data);
  r = await other.call("GET", "/api/account");
  check("accounts cannot list another traveller's bookings", r.data.bookings.length === 0, r.data);

  r = await ama.call("POST", "/api/account/logout");
  check("logout succeeds", r.res.status === 200, r.data);
  check("logout expires the cookie", /Max-Age=0/i.test(r.set), r.set);
  r = await ama.call("GET", "/api/account");
  check("history is private after logout", r.data.account === null && r.data.bookings.length === 0, r.data);

  r = await ama.call("POST", "/api/account/login", { email: "ama@example.com", password: "wrong-password" });
  check("wrong password is refused", r.res.status === 401, r.data);
  r = await ama.call("POST", "/api/account/login", { email: "AMA@example.com", password: "a-long-test-password" });
  check("login is case-insensitive by email", r.res.status === 200 && r.data.account.name === "Ama Account", r.data);
  r = await ama.call("GET", "/api/account");
  check("the same booking returns after logout and login", r.data.bookings.length === 1 && r.data.bookings[0].code === code, r.data);

  const accountsRaw = await readFile(join(scratch, "accounts.json"), "utf8");
  check("password is not stored in plain text", !accountsRaw.includes("a-long-test-password"), "plaintext password found");
  check("raw session token is not stored", !accountsRaw.includes(ama.cookie.split("=")[1]), "plaintext session token found");
  const manifestRaw = await readFile(db, "utf8");
  check("the manifest never stores a readable handover PIN", !manifestRaw.includes('"pin":'), "readable PIN found");

  await stop();
  await start();
  const returning = client();
  r = await returning.call("POST", "/api/account/login", { email: "ama@example.com", password: "a-long-test-password" });
  check("account survives a server restart", r.res.status === 200, r.data);
  r = await returning.call("GET", "/api/account");
  check("booking history survives a server restart", r.data.bookings.length === 1 && r.data.bookings[0].code === code, r.data);

  console.log(`\n${checks} account checks passed`);
} finally {
  await stop();
  await rm(scratch, { recursive: true, force: true });
}
