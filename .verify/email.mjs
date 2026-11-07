import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBookingMailer, bookingReceipt } from "../core/email.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const scratch = await mkdtemp(join(tmpdir(), "haul-email-"));
const db = join(scratch, "shipments.json");
const appPort = 8817;
const stubPort = 8818;
const base = `http://127.0.0.1:${appPort}`;
const stubUrl = `http://127.0.0.1:${stubPort}/emails`;
let child;
let stub;
let checks = 0;
const stubState = { mode: "ok", messages: [], delayMs: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, condition, detail) {
  checks++;
  assert.ok(condition, `${name}: ${JSON.stringify(detail)}`);
  console.log(`ok ${checks} — ${name}`);
}

async function startStub() {
  stub = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    stubState.messages.push({ url: req.url, headers: req.headers, body });
    if (stubState.delayMs) await sleep(stubState.delayMs);
    if (stubState.mode === "fail") {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "stub failure" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "stub-email-id" }));
  });
  await new Promise((r) => stub.listen(stubPort, "127.0.0.1", r));
}

async function start(env = {}) {
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(appPort),
      DB: db,
      BROWN_OFFLINE: "1",
      HAUL_TOKEN: "test-only-depot-token",
      RESEND_API_KEY: "test-only-resend-key",
      RESEND_FROM: "BrownHub Haul <haul@example.test>",
      RESEND_ENDPOINT: stubUrl,
      PUBLIC_BASE_URL: base,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => { output += b; });
  child.stderr.on("data", (b) => { output += b; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    await sleep(50);
  }
  throw new Error(`server did not start: ${output}`);
}

async function stop() {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((r) => child.once("exit", r));
  child.kill("SIGTERM");
  await done;
}

const booking = {
  customerName: "Ama Receipt",
  customerPhone: "+233 53 558 3460",
  customerEmail: "ama@example.test",
  fromId: "kokomlemle",
  toId: "kotoka",
  pickupDate: "2026-11-10",
  pickupWindow: "10:00 – 12:00",
  pieces: 2,
  weightKg: 22,
  declaredValue: 4000,
  service: "standard",
  insurance: true,
};

async function postBooking(payload) {
  const res = await fetch(`${base}/api/shipments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { res, data: await res.json() };
}

try {
  await startStub();

  const blueprint = await readFile(join(ROOT, "render.yaml"), "utf8");
  for (const path of ["/data/shipments.json", "/data/accounts.json", "/data/photos", "/data/brand.json", "/data/secret.key"])
    check(`blueprint keeps ${path} on the durable disk`, blueprint.includes(path), path);
  check("Resend key is dashboard-only", /key:\s*RESEND_API_KEY\s*\n\s*sync:\s*false/.test(blueprint) && !/key:\s*RESEND_API_KEY\s*\n\s*value:/.test(blueprint), "RESEND_API_KEY must use sync:false");
  check("Resend sender is dashboard-only", /key:\s*RESEND_FROM\s*\n\s*sync:\s*false/.test(blueprint) && !/key:\s*RESEND_FROM\s*\n\s*value:/.test(blueprint), "RESEND_FROM must use sync:false");

  const sample = {
    code: "BH-7K2M9X",
    customer: { name: "Ama Receipt", email: "ama@example.test" },
    from: { name: "Kokomlemle" },
    to: { name: "Kotoka International Airport" },
    logistics: { pieces: 2, weightKg: 22, service: "standard" },
    pickup: { date: "2026-11-10", window: "10:00 – 12:00" },
    total: 180.5,
    pin: "1234",
    pinSeal: "aes256gcm:should-never-leak",
  };
  const receipt = bookingReceipt(sample, `${base}/#/track/BH-7K2M9X`);
  check("receipt subject names the booking", /BH-7K2M9X/.test(receipt.subject), receipt.subject);
  check("receipt text includes tracking link", receipt.text.includes(`${base}/#/track/BH-7K2M9X`) && /Track your haul/.test(receipt.text), receipt.text);
  check("receipt includes the payment-at-collection reminder", /pay .*collection/i.test(receipt.text) && /pay .*collection/i.test(receipt.html), receipt);
  check("receipt html escapes traveller content", bookingReceipt({ ...sample, customer: { name: "<script>alert(1)</script>", email: "ama@example.test" } }, `${base}/#/track/BH-7K2M9X`).html.includes("&lt;script&gt;"), "unescaped html");
  check("receipt never includes a handover PIN or seal", !/1234|pinSeal|should-never-leak/.test(receipt.text + receipt.html), "secret leaked");

  const missingConfig = createBookingMailer({});
  const missingResult = await missingConfig.sendReceipt(sample, `${base}/#/track/BH-7K2M9X`);
  check("missing email configuration is non-blocking", missingResult.attempted && !missingResult.delivered && /confirmed/i.test(missingResult.message), missingResult);

  const timeoutMailer = createBookingMailer({ apiKey: "test", from: "haul@example.test", endpoint: stubUrl, timeoutMs: 20 });
  stubState.delayMs = 120;
  const timeoutResult = await timeoutMailer.sendReceipt(sample, `${base}/#/track/BH-7K2M9X`);
  stubState.delayMs = 0;
  check("provider timeout is non-blocking", timeoutResult.attempted && !timeoutResult.delivered, timeoutResult);

  await start();
  stubState.messages.length = 0;
  let r = await postBooking(booking);
  check("booking with email succeeds", r.res.status === 201 && r.data.ok, r.data);
  check("booking reports delivered email", r.data.email?.attempted === true && r.data.email?.delivered === true, r.data.email);
  check("stub received exactly one message", stubState.messages.length === 1, stubState.messages.length);
  const sent = stubState.messages[0]?.body;
  check("stub message targets the traveller", sent?.to?.[0] === "ama@example.test", sent?.to);
  check("stub request authenticates without exposing the key in the message", stubState.messages[0]?.headers?.authorization === "Bearer test-only-resend-key" && !JSON.stringify(sent).includes("test-only-resend-key"), stubState.messages[0]?.headers?.authorization);
  check("stub message uses the configured sender", sent?.from === "BrownHub Haul <haul@example.test>", sent?.from);
  check("stub message links to the tracking code", sent?.html?.includes(`/#/track/${r.data.code}`), sent?.html?.slice(0, 200));
  check("stub message never contains the one-time PIN", !JSON.stringify(sent).includes(r.data.pin), "PIN leaked to email");
  check("stub message never contains the PIN seal", !JSON.stringify(sent).includes("pinSeal"), "seal leaked to email");
  const deliveredCode = r.data.code;

  stubState.messages.length = 0;
  r = await postBooking({ ...booking, customerEmail: "" });
  check("booking without email still succeeds", r.res.status === 201, r.data);
  check("no-email booking does not attempt delivery", r.data.email?.attempted === false, r.data.email);
  check("no-email booking sends nothing", stubState.messages.length === 0, stubState.messages.length);

  stubState.mode = "fail";
  stubState.messages.length = 0;
  r = await postBooking(booking);
  check("provider failure does not roll back the booking", r.res.status === 201 && !!r.data.code, r.data);
  check("provider failure is reported as a warning", r.data.email?.attempted === true && r.data.email?.delivered === false && /confirmed/i.test(r.data.email?.message || ""), r.data.email);
  const failedCode = r.data.code;
  stubState.mode = "ok";

  await stop();
  await start();
  const tracked = await fetch(`${base}/api/shipments/${deliveredCode}`);
  check("emailed booking survives a server restart", tracked.status === 200, tracked.status);
  const failedTracked = await fetch(`${base}/api/shipments/${failedCode}`);
  check("booking survives even when email failed", failedTracked.status === 200, failedTracked.status);

  const manifestRaw = await readFile(db, "utf8");
  check("manifest still never stores a readable PIN", !manifestRaw.includes('"pin":'), "readable PIN found");

  console.log(`\n${checks} email checks passed`);
} finally {
  await stop();
  if (stub) await new Promise((r) => stub.close(r));
  await rm(scratch, { recursive: true, force: true });
}