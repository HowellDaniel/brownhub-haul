/** Minimal CDP client over Node 24's global WebSocket.
 *  Enough to drive a real page with trusted input: no synthetic events, no jsdom. */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Conn {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener("open", res, { once: true });
      this.ws.addEventListener("error", () => rej(new Error("cdp socket error")), { once: true });
      setTimeout(() => rej(new Error("cdp socket timeout")), 10000);
    });
    this.ws.addEventListener("message", (e) => this.#dispatch(JSON.parse(e.data)));
  }

  #dispatch(m) {
    if (m.id && this.pending.has(m.id)) {
      const { res, rej, timer } = this.pending.get(m.id);
      this.pending.delete(m.id);
      clearTimeout(timer);
      m.error ? rej(new Error(`${m.method}: ${m.error.message}`)) : res(m.result);
      return;
    }
    if (m.method) for (const fn of this.listeners.get(m.method) || []) fn(m.params);
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`cdp timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { res, rej, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws.close(); } catch { /* already gone */ }
  }
}

/** Launch-gate helper: find a page target the debugger can attach to. */
export async function connect(port, say = () => {}, timeoutMs = 30000) {
  let target = null;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && !target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    } catch { /* chrome still booting */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error(`no CDP page target on ${port}`);
  const conn = new Conn(target.webSocketDebuggerUrl);
  await conn.open();
  say(`cdp attached to ${target.url || "about:blank"}`);
  return { conn, target };
}

export async function session(port, say = () => {}) {
  const { conn, target } = await connect(port, say);
  await conn.send("Page.enable");
  await conn.send("Runtime.enable");
  await conn.send("DOM.enable");
  await conn.send("Log.enable");
  await conn.send("Network.enable");
  // Always take frames from disk — a previous run's Chrome can hand back a stale tab.
  await conn.send("Page.navigate", { url: target.url || "about:blank" });
  await conn.send("Page.reload", { ignoreCache: true }).catch(() => {});

  const evalJS = async (expression, { awaitPromise = false } = {}) => {
    const r = await conn.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval threw");
    return r.result?.value;
  };

  const centerOf = async (selector) => {
    // bring it into the viewport first, then measure — coordinates must be real
    const box = await evalJS(
      `(() => { const e = document.querySelector(${JSON.stringify(selector)});
        if (!e) return null;
        e.scrollIntoView({ block: 'center', inline: 'center' });
        const r = e.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height),
                 visible: r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }; })()`
    );
    if (!box) throw new Error(`no such element: ${selector}`);
    if (!box.visible) throw new Error(`element is not painted: ${selector} (${box.w}x${box.h})`);
    return box;
  };

  let windowId = null;
  const bounds = await conn.send("Browser.getWindowForTarget").catch(() => null);
  if (bounds?.windowId) windowId = bounds.windowId;

  return {
    conn,
    eval: evalJS,
    raw: (m, p) => conn.send(m, p),

    /** Input coordinates are in the REAL window's pixels: overriding device
     *  metrics alone leaves the window 800x600, so any click below/right of
     *  that silently misses. Resize the window to match, every time. */
    async setWindow(width, height) {
      if (!windowId) return;
      await conn.send("Browser.setWindowBounds", { windowId, bounds: { width, height, windowState: "normal" } }).catch(() => {});
    },

    async navigate(url) {
      const done = new Promise((res) => conn.on("Page.loadEventFired", res));
      await conn.send("Page.navigate", { url });
      await Promise.race([done, sleep(4000)]);
      await sleep(350);
    },

    async setSize(width, height, mobile = false, dpr = 2) {
      await conn.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile });
      // maxTouchPoints must be 1..16 — sending 0 with enabled:false is a hard error.
      await conn.send("Emulation.setTouchEmulationEnabled", mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false, maxTouchPoints: 1 });
      // Trusted input is mapped through the real window, so an override larger
      // than the window would put every click outside it. Keep them in step.
      await this.setWindow(width, Math.max(height, 500));
    },

    async click(selector) {
      const { x, y } = await centerOf(selector);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await conn.send("Input.dispatchMouseEvent", {
          type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0, charCode: 0,
        });
      }
      await sleep(90);
    },

    /** Click an element found by an arbitrary JS expression (e.g. the row for a code). */
    async clickExpr(expr, label = "expression") {
      const r = await conn.send("Runtime.evaluate", { expression: `(${expr})`, returnByValue: false });
      const objectId = r.result?.objectId;
      if (!objectId) throw new Error(`no element for ${label}`);
      const box = await conn.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function(){ this.scrollIntoView({block:'center', inline:'center'});
          const r = this.getBoundingClientRect();
          return {x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height, vis:getComputedStyle(this).visibility}; }`,
        returnByValue: true,
      });
      const b = box.result.value;
      if (!b.w || !b.h) throw new Error(`${label} has zero size`);
      if (b.vis === "hidden") throw new Error(`${label} is hidden`);
      for (const type of ["mousePressed", "mouseReleased"])
        await conn.send("Input.dispatchMouseEvent", { type, x: b.x, y: b.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
      await conn.send("Runtime.releaseObjectGroup", { objectGroup: "verify" }).catch(() => {});
      await sleep(120);
    },

    async type(selector, text) {
      await this.click(selector);
      await conn.send("Input.insertText", { text });
      await conn.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Unidentified", code: "Unidentified" }).catch(() => {});
      // React-free vanilla inputs already fired `input` from insertText; nudge change for selects.
      await evalJS(
        `(() => { const e = document.querySelector(${JSON.stringify(selector)});
          e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`
      );
      await sleep(120);
    },

    /** Real selection of an <option>: pointer down on the select, then set + change. */
    async pick(selector, value) {
      await this.click(selector);
      await evalJS(
        `(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(value)};
          s.dispatchEvent(new Event('change', { bubbles: true })); s.dispatchEvent(new Event('input', { bubbles: true })); })()`
      );
      await sleep(150);
    },

    /** Put real files into an <input type=file> — the only way to drive a camera
     *  capture without a phone. CDP sets .files and fires input/change itself. */
    async setFiles(selector, paths) {
      const doc = await conn.send("DOM.getDocument", { depth: -1 });
      const { nodeId } = await conn.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
      if (!nodeId) throw new Error(`no input at ${selector}`);
      await conn.send("DOM.setFileInputFiles", { files: paths, nodeId });
      await sleep(150);
    },

    async shot(path, { full = false } = {}) {
      const { writeFile } = await import("node:fs/promises");
      const img = await conn.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: full,
        clip: full
          ? await evalJS(`(() => { const d = document.documentElement; return { x: 0, y: 0, width: d.scrollWidth, height: Math.min(d.scrollHeight, 5000), scale: 1 }; })()`)
          : undefined,
      });
      await writeFile(path, Buffer.from(img.data, "base64"));
      return path;
    },

    consoleErrors: () => {
      const out = [];
      conn.on("Runtime.exceptionThrown", (p) => out.push(`exception: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`));
      conn.on("Log.entryAdded", (p) => {
        const e = p.entry;
        if (e.level === "error" && !/favicon|404|net::ERR_FILE/i.test(e.text || "")) out.push(`${e.source}: ${e.text} ${e.url || ""}`);
      });
      conn.on("Network.responseReceived", (p) => {
        const u = p.response.url || p.url || "";
        if (p.response.status >= 400 && !/favicon/.test(u)) out.push(`http ${p.response.status} ${u}`);
      });
      return out;
    },
  };
}
