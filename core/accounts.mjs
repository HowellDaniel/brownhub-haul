import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SESSION_DAYS = 30;
const DUMMY_SALT = randomBytes(16);

export class AccountStore {
  constructor(file, lock) {
    this.file = file;
    this.lock = lock;
    mkdirSync(dirname(file), { recursive: true });
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { accounts: [], sessions: [] };
    if (!Array.isArray(this.data.accounts)) this.data.accounts = [];
    if (!Array.isArray(this.data.sessions)) this.data.sessions = [];
  }

  #flush() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  #hash(password, salt) {
    return scryptSync(String(password), salt, 64);
  }

  #verify(password, encoded) {
    const parts = String(encoded || "").split("$");
    if (parts.length !== 3 || parts[0] !== "scrypt") return false;
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    const actual = this.#hash(password, salt);
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  }

  create({ name, email, phone, password } = {}) {
    const cleanName = String(name || "").trim();
    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanPhone = String(phone || "").trim();
    const errors = [];
    if (cleanName.length < 2 || cleanName.length > 80) errors.push({ field: "name", message: "Enter your full name." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 160) errors.push({ field: "email", message: "Enter a valid email address." });
    if (String(password || "").length < 10 || String(password || "").length > 128) errors.push({ field: "password", message: "Use a password between 10 and 128 characters." });
    if (cleanPhone && cleanPhone.replace(/\D/g, "").length < 9) errors.push({ field: "phone", message: "Enter a reachable phone number, or leave it blank." });
    if (errors.length) return { ok: false, errors };
    if (this.data.accounts.some((a) => a.email === cleanEmail)) return { ok: false, conflict: true, errors: [{ field: "email", message: "An account already uses this email. Log in instead." }] };

    const salt = randomBytes(16);
    const account = {
      id: randomBytes(16).toString("hex"),
      name: cleanName,
      email: cleanEmail,
      phone: cleanPhone,
      passwordHash: `scrypt$${salt.toString("hex")}$${this.#hash(password, salt).toString("hex")}`,
      createdAt: new Date().toISOString(),
    };
    this.data.accounts.push(account);
    this.#flush();
    return { ok: true, account };
  }

  authenticate(email, password) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    const account = this.data.accounts.find((a) => a.email === cleanEmail);
    const valid = account
      ? this.#verify(password, account.passwordHash)
      : (this.#hash(password, DUMMY_SALT), false);
    return valid ? account : null;
  }

  view(account) {
    if (!account) return null;
    return { id: account.id, name: account.name, email: account.email, phone: account.phone, createdAt: account.createdAt };
  }

  createSession(accountId) {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.data.sessions = this.data.sessions.filter((s) => Date.parse(s.expiresAt) > now);
    this.data.sessions.push({
      accountId,
      tokenMac: this.lock.mac(token).toString("hex"),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_DAYS * 86400000).toISOString(),
    });
    this.#flush();
    return token;
  }

  accountForSession(token) {
    if (!token) return null;
    const mac = this.lock.mac(token).toString("hex");
    const session = this.data.sessions.find((s) => s.tokenMac === mac && Date.parse(s.expiresAt) > Date.now());
    return session ? this.data.accounts.find((a) => a.id === session.accountId) || null : null;
  }

  destroySession(token) {
    if (!token) return;
    const mac = this.lock.mac(token).toString("hex");
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.tokenMac !== mac);
    if (this.data.sessions.length !== before) this.#flush();
  }
}
