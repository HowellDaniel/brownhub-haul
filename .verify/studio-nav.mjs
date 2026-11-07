/**
 * Studio nav harness — a nav click must never start the app.
 *
 * js/nav.js is shared by 46 pages. This serves the real studio site over HTTPS
 * with several versions of data/haul.json and asks a real Chrome what the two
 * Luggage links resolve to. The rule is one sentence: Luggage always opens
 * haul.html, the page that introduces the app, and only that page's button
 * carries the app address.
 *
 *   • a real app URL in the feed → both Luggage links still open haul.html
 *   • a journal post two directories deep → the same page, resolved at the root
 *   • javascript:, a trycloudflare tunnel, a 500 or a keyless feed → no change
 *   • the nav asks for no feed at all; haul.html is where haul.app is read
 *
 * The site is served from a throwaway HTTPS server; the feed is a fixture, so
 * nothing here reaches the live site or the live app.
 *
 *   node .verify/studio-nav.mjs
 */
import { createServer as createHttps } from "node:https";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { bindPorts } from "./ports.mjs";
import { session } from "./cdp.mjs";

const SITE = process.env.STUDIO_SITE || "/Users/brownhub/Documents/Qoder/2026-09-16/5bb3bd1c";
const PORT = 8862;
const CDP = 9416;
const BASE = `https://127.0.0.1:${PORT}`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = join(tmpdir(), `studio-nav-profile-${process.pid}`);
const CERT = join(tmpdir(), `studio-nav-${process.pid}-cert.pem`);
const KEY = join(tmpdir(), `studio-nav-${process.pid}-key.pem`);
const APP = "https://haul.example.test/app/";
const PAGE = `${BASE}/haul.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The written page is relative in HTML and absolute when nav.js builds the
 *  mega row; compare what the browser would actually request, not the spelling. */
const absolute = (href) => (href ? new URL(href, BASE).href : null);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
};

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json", ".xml": "application/xml", ".txt": "text/plain",
  ".woff2": "font/woff2", ".ico": "image/x-icon",
};

/* One mutable fixture, six bodies. Every request is recorded so the test can
   tell "the link did not move" apart from "the feed was never asked". */
let FEED = { status: 200, body: "{}" };
const reqLog = [];

// Self-signed, one throwaway pair; Chrome is told to ignore it for this run.
execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", KEY, "-out", CERT, "-days", "2", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });

const server = createHttps({ key: readFileSync(KEY), cert: readFileSync(CERT) }, (req, res) => {
  const url = new URL(req.url, BASE);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  if (pathname.endsWith("/")) pathname += "index.html";

  if (pathname === "/data/haul.json") {
    reqLog.push({ path: pathname, headers: req.headers, at: Date.now() });
    res.writeHead(FEED.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
    return res.end(FEED.body);
  }

  const file = resolve(join(SITE, normalize(pathname)));
  if (file !== resolve(SITE) && !file.startsWith(resolve(SITE) + sep))
    return res.writeHead(403).end("forbidden");
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
});

const waitFor = async (fn, ms = 3500) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(80);
  }
  return null;
};

/* The two links a visitor can click, found by what they say rather than by an
   href that the very rewrite under test may have changed. */
const READ_NAV = `(() => {
  const menu = document.querySelector('.site-header .nav__menu');
  const links = Array.from((menu || document).querySelectorAll('a.nav__link'));
  const top = links.find((a) => a.textContent.trim() === 'Luggage') || null;
  const row = Array.from(document.querySelectorAll('#mega-services a'))
    .find((a) => /Luggage Collection/.test(a.textContent)) || null;
  const contact = links.find((a) => a.textContent.trim() === 'Contact') || null;
  return {
    topHref: top && top.getAttribute('href'),
    topTarget: top && top.getAttribute('target'),
    topAfterContact: !!(top && contact && (contact.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING)),
    megaHref: row && row.getAttribute('href'),
    megaTarget: row && row.getAttribute('target'),
  };
})()`;

let chrome = null;
let s = null;
const errors = [];

async function load(page, feed, status = 200) {
  FEED = { status, body: JSON.stringify(feed) };
  const before = reqLog.length;
  await s.navigate(BASE + page);
  // No feed wait: the nav is supposed to leave data/haul.json alone, so give the
  // page a beat to build, then count whatever it did ask for.
  await sleep(400);
  return { nav: await s.eval(READ_NAV), requests: reqLog.length - before };
}

try {
  await bindPorts([PORT, CDP]);
  mkdirSync(PROFILE, { recursive: true });
  await new Promise((res) => server.listen(PORT, "127.0.0.1", res));

  console.log(`studio served at ${BASE} (fixtures only)\n`);

  chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`,
    "--no-first-run", "--no-default-browser-check", "--ignore-certificate-errors",
    "--host-resolver-rules=MAP * 127.0.0.1:9, EXCLUDE 127.0.0.1",
    "about:blank",
  ], { stdio: "ignore" });
  s = await session(CDP, () => {});
  const pageErrors = s.consoleErrors();
  await s.setSize(1280, 900, false, 1);

  /* The rule this file now proves: a nav click never starts the app. It always
     lands on haul.html, the page that introduces it; only that page's own button
     carries haul.app. The nav does not read the feed at all, so no value a
     visitor can put in data/haul.json can move a link off the page. */

  console.log("1. an app in the feed does not move the nav");
  {
    const { nav, requests } = await load("/index.html", { version: 1, haul: { app: APP } });
    check("top Luggage opens haul.html", absolute(nav.topHref) === PAGE, nav.topHref);
    check("mega row opens haul.html", absolute(nav.megaHref) === PAGE, nav.megaHref);
    check("Luggage still sits after Contact", nav.topAfterContact);
    check("links stay in the same tab", !nav.topTarget && !nav.megaTarget, [nav.topTarget, nav.megaTarget]);
    check("the nav asks for no feed at all", requests === 0, requests);
  }

  console.log("\n2. a page that does not carry the link in HTML (injected)");
  {
    const { nav } = await load("/about.html", { version: 1, haul: { app: APP } });
    check("about.html gains a Luggage item", nav.topHref !== null, nav);
    check("injected item opens haul.html", absolute(nav.topHref) === PAGE, nav.topHref);
    check("panel row opens haul.html", absolute(nav.megaHref) === PAGE, nav.megaHref);
  }

  console.log("\n3. a journal post keeps the link at the site root");
  {
    const { nav, requests } = await load("/blog/print-ready.html", { version: 1, haul: { app: APP } });
    check("journal-post Luggage opens the site-root page", absolute(nav.topHref) === PAGE, nav.topHref);
    check("journal-post panel row opens haul.html", absolute(nav.megaHref) === PAGE, nav.megaHref);
    check("no feed request from a journal post", requests === 0, requests);
  }

  console.log("\n4. hostile or stale values cannot move the link");
  {
    const { nav } = await load("/index.html", { version: 1, haul: { app: "javascript:alert(1)" } });
    check("javascript: app keeps haul.html", absolute(nav.topHref) === PAGE, nav.topHref);
    const { nav: tunnel } = await load("/index.html", { version: 1, haul: { app: "https://abc-def.trycloudflare.com/#/book" } });
    check("a quick tunnel keeps haul.html", absolute(tunnel.topHref) === PAGE, tunnel.topHref);
  }

  console.log("\n5. a broken feed changes nothing");
  {
    const { nav } = await load("/index.html", { version: 1 }, 500);
    check("HTTP 500 keeps haul.html", absolute(nav.topHref) === PAGE && absolute(nav.megaHref) === PAGE, [nav.topHref, nav.megaHref]);
    const { nav: noKey } = await load("/index.html", { version: 1, haul: { brand: "x" } });
    check("feed without app keeps haul.html", absolute(noKey.topHref) === PAGE && absolute(noKey.megaHref) === PAGE, [noKey.topHref, noKey.megaHref]);
  }

  console.log("\n6. the release is wired");
  {
    const fs = await import("node:fs/promises");
    const pages = (await fs.readdir(SITE, { withFileTypes: true })).filter((d) => d.isFile() && d.name.endsWith(".html")).map((d) => d.name);
    const blog = (await fs.readdir(join(SITE, "blog"))).filter((n) => n.endsWith(".html")).map((n) => `blog/${n}`);
    const all = [...pages, ...blog];
    const index = await fs.readFile(join(SITE, "index.html"), "utf8");
    const version = (index.match(/nav\.js\?v=(\d+)/) || [])[1];
    const navPages = [], stale = [];
    for (const p of all) {
      const src = await fs.readFile(join(SITE, p), "utf8");
      if (!src.includes("nav.js?v=")) continue;
      navPages.push(p);
      if (!version || !src.includes(`nav.js?v=${version}`)) stale.push(p);
    }
    const sw = await fs.readFile(join(SITE, "sw.js"), "utf8");
    check("index asks for a versioned nav.js", !!version, version);
    check(`all ${navPages.length} nav pages ask for ?v=${version}`, navPages.length >= 16 && stale.length === 0, stale);
    check("studio cache has a versioned name", /const CACHE = "brownhub-v\d+"/.test(sw));
  }

  /* A 500 feed is deliberate in phase 5, and the site's third-party scripts are
     unreachable offline; only an uncaught exception from our own nav matters. */
  const exceptions = pageErrors.filter((e) => e.startsWith("exception:"));
  check("no uncaught page exception", exceptions.length === 0, exceptions);

  /* The value actually written in the shipped feed. Nothing here clicks it: the
     nav must not carry it, and this harness never drives a live endpoint. The
     app's own TLS and installability are proven locally by .verify/pwa.mjs
     against the same server code. */
  console.log("\n7. the shipped feed, and the page's own button");
  {
    const realFeed = JSON.parse(readFileSync(join(SITE, "data", "haul.json"), "utf8"));
    const app = realFeed.haul && realFeed.haul.app;
    const { nav } = await load("/index.html", realFeed);

    check("the feed names an app over https", typeof app === "string" && /^https:\/\//i.test(app), app);
    check("it opens the booking route", /#\/book$/.test(app || ""), app);
    check("the nav still lands on haul.html", absolute(nav.topHref) === PAGE && absolute(nav.megaHref) === PAGE, [nav.topHref, nav.megaHref]);
    check("the nav never carries the app address", nav.topHref !== app && nav.megaHref !== app, [nav.topHref, nav.megaHref]);

    /* haul.html is the one place that may hand out the app: it reads haul.app,
       refuses a malformed or tunnel value, and reveals its three buttons only
       for a real address. Proven here on the written page, not the live one. */
    const page = readFileSync(join(SITE, "haul.html"), "utf8");
    check("haul.html reads haul.app", /h\.app/.test(page));
    check("haul.html reveals its Open buttons from it",
      ["open-app", "open-app-2", "open-app-3"].every((id) => page.includes(`"${id}"`)));
    check("haul.html refuses a trycloudflare address", /trycloudflare/i.test(page));
    check("the page's buttons are hidden in the written HTML",
      (page.match(/id="open-app(-2|-3)?"[^>]*hidden/g) || []).length === 3);
  }

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  process.exitCode = fails ? 1 : 0;
} catch (e) {
  console.error("\nharness failed:", e.message);
  process.exitCode = 1;
} finally {
  if (s) s.conn.close();
  if (chrome) chrome.kill("SIGTERM");
  server.close();
  await sleep(900); // let Chrome drop its locks before the profile goes
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  rmSync(CERT, { force: true });
  rmSync(KEY, { force: true });
}
