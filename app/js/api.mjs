/** One fetch wrapper. Everything the UI knows about the world comes from /api.
 *
 * The depot passphrase lives in sessionStorage, not localStorage: the board is
 * unlocked for the shift, and closing the tab locks it again. It rides on every
 * request because the server only accepts it on the dispatch routes anyway.
 */

const JSON_HEADERS = { "content-type": "application/json" };
const TOKEN_KEY = "haul.dispatch.token";

function readToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}

export const auth = {
  get token() { return readToken(); },
  get unlocked() { return !!readToken(); },
  unlock(token) {
    try { sessionStorage.setItem(TOKEN_KEY, String(token).trim()); } catch { /* private mode: stay locked */ }
  },
  lock() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* nothing to clear */ }
  },
};

async function call(method, url, body) {
  const headers = { ...(body !== undefined ? JSON_HEADERS : {}) };
  const token = readToken();
  if (token) headers["x-haul-token"] = token;

  const res = await fetch(url, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new Error(`${method} ${url} → ${res.status} (not JSON)`);
  }
  if (!res.ok || data.ok === false) {
    // `message` is the human-facing line the API intends for the traveller or
    // the driver (e.g. a refused handover PIN) — it must not become "422".
    const e = new Error(
      data?.message || data?.error || data?.errors?.[0]?.message || `Request failed (${res.status})`
    );
    e.status = res.status;
    e.errors = data?.errors || [];
    if (res.status === 401) auth.lock(); // a rotated passphrase must not linger
    throw e;
  }
  return data;
}

export const api = {
  config: () => call("GET", "api/config"),
  places: () => call("GET", "api/places"),
  shipments: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v && v !== "all"));
    return call("GET", `api/shipments${q ? `?${q}` : ""}`);
  },
  shipment: (code) => call("GET", `api/shipments/${encodeURIComponent(code)}`),
  create: (payload) => call("POST", "api/shipments", payload),
  advance: (code, patch = {}) => call("PATCH", `api/shipments/${encodeURIComponent(code)}`, { action: "advance", ...patch }),
  verifyPin: (code, pin) => call("PATCH", `api/shipments/${encodeURIComponent(code)}`, { action: "verify-pin", pin }),
  exception: (code, note) => call("PATCH", `api/shipments/${encodeURIComponent(code)}`, { action: "exception", note }),
  photo: (code, data, note) => call("POST", `api/shipments/${encodeURIComponent(code)}/photos`, { data, note }),
};
