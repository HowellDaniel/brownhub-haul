/**
 * BrownHub Haul — the small crypto corner of the store. Node-only.
 *
 * Two jobs, both about what survives someone reading data/shipments.json:
 *
 *  1. A handover PIN must not sit in the manifest in plain text. It is sealed
 *     with AES-256-GCM under a per-install key (data/secret.key, 0600), so the
 *     JSON file alone is not a list of door codes. The dispatch screen — the one
 *     place that has to read a PIN aloud to a traveller on WhatsApp — unseals it
 *     on demand, and only for a request that carries the depot token.
 *
 *  2. The depot token itself is never stored, only its HMAC-SHA256, so the same
 *     file cannot be used to mint a valid token.
 *
 * The threat model is a lost laptop or a committed manifest, not a determined
 * attacker with the key file: the key lives beside the data, so anyone holding
 * both can decrypt. That is still a real step up from plaintext.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const PREFIX = "aes256gcm:";

/** 20 characters, no I/O/0/1 — the desk reads it over the phone. */
export function newToken() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(20);
  let out = "";
  for (let i = 0; i < 20; i++) out += alphabet[bytes[i] % alphabet.length];
  return `BHDEPOT-${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15)}`;
}

export class Lockbox {
  /** keyFile holds 32 random bytes, base64. Created 0600 on first boot. */
  constructor(keyFile, { keyFromEnv } = {}) {
    this.file = keyFile;
    let raw;
    if (keyFromEnv && process.env[keyFromEnv]) {
      raw = Buffer.from(process.env[keyFromEnv], "base64");
      if (raw.length !== 32) throw new Error(`${keyFromEnv} must be 32 bytes of base64`);
      this.#write(raw); // persist so a restart with the env unset still reads old records
    } else if (existsSync(keyFile)) {
      raw = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
      if (raw.length !== 32) throw new Error(`store: ${keyFile} is not a 32-byte key. Restore it — sealed PINs cannot be read without it.`);
    } else {
      raw = randomBytes(32);
      this.#write(raw);
    }
    this.key = raw;
  }

  #write(raw) {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, raw.toString("base64"), { mode: 0o600 });
    try { chmodSync(this.file, 0o600); } catch { /* best effort on odd filesystems */ }
  }

  /** Encrypt a short secret into a string safe to drop in the JSON manifest. */
  seal(plain) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
    return `${PREFIX}${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
  }

  /** Returns null rather than throwing: a record sealed under a lost key is
   *  unreadable, and the manifest must still open for everything else. */
  open(sealed) {
    if (typeof sealed !== "string" || !sealed.startsWith(PREFIX)) return null;
    const [iv, tag, ct] = sealed.slice(PREFIX.length).split(".").map((p) => Buffer.from(p, "base64"));
    if (!iv || !tag || !ct) return null;
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  /** Keyed digest — used to compare the depot token without storing it. */
  mac(value) {
    return createHmac("sha256", this.key).update(String(value)).digest();
  }

  /** Constant-time comparison of a candidate against a stored HMAC. */
  matches(value, macHex) {
    if (typeof value !== "string" || typeof macHex !== "string") return false;
    const a = this.mac(value);
    const b = Buffer.from(macHex, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
