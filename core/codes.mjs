/** Tracking codes and handover PINs.
 *  Browser-safe on purpose (no node: imports) so the form can validate a code
 *  before it costs a round trip. */

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 — read aloud over the phone
export const CODE_LEN = 6;
export const CODE_RE = /^BH-[A-Z2-9]{6}$/;

export function newCode(rand = Math.random) {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return `BH-${s}`;
}

export function normalizeCode(code) {
  return String(code || "").trim().toUpperCase().replace(/\s+/g, "");
}

export function isValidCode(code) {
  return CODE_RE.test(normalizeCode(code));
}

export function newPin(rand = Math.random) {
  return String(Math.floor(rand() * 9000) + 1000);
}
