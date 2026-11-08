(function () {
  "use strict";

  /* Groups rather than an alphabetical wall: the point is that a visitor finds
     their own language by eye. Each code owns a file in i18n/, and a language
     added to a dictionary has to be added here too. The names are written in
     English so the sheet reads as one list; the pane is skipped by collect(),
     because a language name is a label and not prose to be translated. */
  var GROUPS = [
    ["Ghana and the region", [["en", "English"], ["tw", "Twi"]]],
    ["Africa and the Middle East", [["sw", "Swahili"], ["ar", "Arabic"], ["he", "Hebrew"],
      ["fa", "Persian"], ["af", "Afrikaans"]]],
    ["Europe", [["fr", "French"], ["de", "German"], ["es", "Spanish"], ["pt", "Portuguese"],
      ["it", "Italian"], ["nl", "Dutch"], ["el", "Greek"], ["sv", "Swedish"],
      ["da", "Danish"], ["fi", "Finnish"], ["pl", "Polish"], ["cs", "Czech"],
      ["sk", "Slovak"], ["hu", "Hungarian"], ["ro", "Romanian"], ["bg", "Bulgarian"],
      ["sr", "Serbian"], ["hr", "Croatian"], ["ru", "Russian"], ["uk", "Ukrainian"],
      ["tr", "Turkish"]]],
    ["Asia", [["zh", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"], ["vi", "Vietnamese"],
      ["th", "Thai"], ["id", "Indonesian"], ["ms", "Malay"], ["tl", "Tagalog"],
      ["bn", "Bengali"], ["ta", "Tamil"], ["hi", "Hindi"], ["ur", "Urdu"]]]
  ];
  var LANGS = [];
  var CODES = {};
  var NAMES = {};
  GROUPS.forEach(function (g) {
    g[1].forEach(function (l) { LANGS.push(l); CODES[l[0]] = 1; NAMES[l[0]] = l[1]; });
  });
  /* The pane's own label for the visitor's device languages. It is painted by
     buildLocale(), which sits outside collect(), so it has to be translated by
     hand every time the page is re-applied. */
  var SUGGEST = "Suggested for you";
  /* Written right to left, so the page has to mirror with the text. */
  var RTL = { ar: 1, he: 1, fa: 1, ur: 1, ps: 1, sd: 1, ku: 1, dv: 1 };
  /* Older or broader tags that mean a language we can serve: browsers still
     report Akan as "ak"/"aka", and a ?lang= word can arrive in full. Keys whose
     target has no dictionary are ignored by resolve(), so this table only ever
     grows as dictionaries land. */
  var ALIAS = { ak: "tw", aka: "tw", akan: "tw", twi: "tw", swahili: "sw",
    arabic: "ar", hebrew: "he", farsi: "fa", persian: "fa", french: "fr",
    spanish: "es", portuguese: "pt", german: "de", dutch: "nl", italian: "it",
    greek: "el", swedish: "sv", danish: "da", czech: "cs", hungarian: "hu",
    polish: "pl", ukrainian: "uk", russian: "ru", turkish: "tr", chinese: "zh",
    japanese: "ja", korean: "ko", vietnamese: "vi", thai: "th", malay: "ms",
    hindi: "hi", urdu: "ur", afrikaans: "af", serbian: "sr", bulgarian: "bg",
    croatian: "hr", slovak: "sk", finnish: "fi", romanian: "ro", bengali: "bn",
    tamil: "ta", tagalog: "tl", filipino: "tl" };
  var ATTRS = ["placeholder", "title", "alt", "aria-label"];
  /* The dictionaries live at the root of the site, but this script is asked for
     them by name relative to the page it runs on — and a page is not always at
     the root. A journal post at /blog/x.html would otherwise fetch
     /blog/i18n/ar.json, get a 404, and the catch below would quietly throw the
     visitor back to English and delete their saved language. The wordmark
     already points at the root of the tree this document is standing in, so its
     own href is the only honest answer. */
  var ROOT = (function () {
    var logo = document.querySelector(".brand");
    if (!logo) return "";
    try {
      return new URL(".", new URL(logo.getAttribute("href") || ".", document.baseURI)).href;
    } catch (e) { return ""; }
  })();
  var dicts = {};
  var rmaps = {};
  var records = [];
  var seen = new WeakSet();
  var seenAttr = new WeakMap();
  var current = "en";
  var localeBtn = null, localeName = null, localePanel = null, suggestHead = null;

  function trimKey(s) { return s ? s.trim() : ""; }

  function t(text) {
    var d = dicts[current];
    if (!d || current === "en") return text;
    var hit = d[trimKey(text)];
    return hit === undefined ? text : hit;
  }

  function record(node, el, attr) {
    var orig = el ? el.getAttribute(attr) : node.nodeValue;
    if (!trimKey(orig || "")) return;
    records.push({ node: node, el: el, attr: attr, orig: orig, last: orig });
  }

  function currentVal(rec) {
    return rec.el ? rec.el.getAttribute(rec.attr) : rec.node.nodeValue;
  }

  function collect(root) {
    if (root.nodeType === 3) {
      if (!seen.has(root)) { seen.add(root); record(root, null, null); }
      return;
    }
    if (root.nodeType !== 1 || root.tagName === "SCRIPT" || root.tagName === "STYLE") return;
    /* A code sample is not prose: the words inside it belong to the program, and a
       translated snippet is a snippet that no longer runs. */
    if (root.hasAttribute("data-i18n-off")) return;
    // The motion script splits data-split text into character spans for animation,
    // destroying the original text nodes. Translate via aria-label instead.
    if (root.hasAttribute("data-split")) {
      if (root.hasAttribute("aria-label") && trimKey(root.getAttribute("aria-label"))) {
        var m = seenAttr.get(root);
        if (!m) { m = {}; seenAttr.set(root, m); }
        if (!m["aria-label"]) { m["aria-label"] = 1; record(null, root, "aria-label"); }
      }
      return;
    }
    // The picker paints its own English names; they are labels, not prose.
    if (root.id === "lang-select" || root.id === "locale-list") return;
  if (root.classList && (root.className === "locale__name" || root.className === "locale__group" ||
      root.classList.contains("locale__opt"))) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      // Empty at scan time does not mean absent forever: the modals fill their attrs on open.
      if (root.hasAttribute(a) && trimKey(root.getAttribute(a) || "")) {
        var m = seenAttr.get(root);
        if (!m) { m = {}; seenAttr.set(root, m); }
        if (!m[a]) { m[a] = 1; record(null, root, a); }
      }
    }
    var kids = root.childNodes;
    for (var j = 0; j < kids.length; j++) collect(kids[j]);
  }

  function write(rec, value) {
    if (rec.el) rec.el.setAttribute(rec.attr, value);
    else rec.node.nodeValue = value;
    rec.last = value;
  }

  function baseOf(rec) {
    var now = currentVal(rec);
    if (now !== rec.last) { rec.orig = now; rec.last = now; }
    return rec.orig;
  }

  function translateRecord(rec, dict) {
    var src = baseOf(rec);
    var hit = dict[trimKey(src)];
    if (hit === undefined) return;
    var lead = src.slice(0, src.length - src.trimStart().length);
    var trail = src.slice(src.trimEnd().length);
    write(rec, lead + hit + trail);
  }

  function applyMeta(dict) {
    if (!dict) {
      document.title = records.metaTitle || document.title;
      if (records.metaDesc) records.metaDesc.content = records.metaDescOrig;
      return;
    }
    var tt = dict[trimKey(records.metaTitle || document.title)];
    if (tt !== undefined) document.title = tt;
    var md = document.querySelector('meta[name="description"]');
    if (md) {
      var mm = dict[trimKey(md.getAttribute("content"))];
      if (mm !== undefined) md.setAttribute("content", mm);
    }
  }

  function loadDict(code) {
    if (dicts[code]) return Promise.resolve(dicts[code]);
    return fetch(ROOT + "i18n/" + code + ".json?v=116")
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) { dicts[code] = d; return d; });
  }

  function revMap(code) {
    if (!rmaps[code]) {
      var d = dicts[code];
      if (!d) return null;
      var m = {};
      for (var k in d) { if (!m[d[k]]) m[d[k]] = k; }
      rmaps[code] = m;
    }
    return rmaps[code];
  }

  function announce() {
    try { document.dispatchEvent(new Event("i18n-applied")); } catch (e) {}
  }

  function setDir(code) {
    var root = document.documentElement;
    if (RTL[code]) root.setAttribute("dir", "rtl");
    else root.removeAttribute("dir");
  }

  function apply(code) {
    // A stale or hand-typed code cannot be trusted: it would announce a language
    // in <html lang> that no dictionary is able to fill.
    if (!CODES[code]) code = "en";
    setDir(code);
    if (code === "en") {
      current = "en";
      records.forEach(function (r) {
        var now = currentVal(r);
        if (now === r.last) write(r, r.orig);
        else { r.orig = now; r.last = now; }
      });
      applyMeta(null);
      announce();
    } else {
      loadDict(code).then(function (dict) {
        current = code;
        records.forEach(function (r) { translateRecord(r, dict); });
        applyMeta(dict);
        // sync() runs after `current` moves; before this promise settles the
        // button is still naming the language the visitor has just left.
        sync();
        announce();
      }).catch(function () {
        setDir("en");
        try { localStorage.removeItem("brownhub-lang"); } catch (e) {}
        if (current !== "en") apply("en");
      });
    }
    document.documentElement.setAttribute("lang", code);
    try { localStorage.setItem("brownhub-lang", code); } catch (e) {}
    sync();
  }

  window.I18N = {
    t: t,
    apply: apply,
    get lang() { return current; },
    // Map a translated string back to its English source (for keyword routing).
    en: function (text) {
      var m = revMap(current);
      if (!m) return text;
      var hit = m[trimKey(text)];
      return hit === undefined ? text : hit;
    },
    translateNode: function (node) {
      var before = records.length;
      collect(node);
      if (current !== "en" && dicts[current]) {
        for (var i = before; i < records.length; i++) translateRecord(records[i], dicts[current]);
      }
    }
  };

  function buildLocale() {
    var host = document.getElementById("locale");
    if (!host || host.firstChild) return;

    host.innerHTML =
      '<button class="locale__btn" type="button" aria-expanded="false" aria-controls="locale-list" aria-label="Choose language">' +
        '<svg class="locale__globe" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.2 9.6h17.6M3.2 14.4h17.6M12 3a15.5 15.5 0 0 1 0 18M12 3a15.5 15.5 0 0 0 0 18"/></svg>' +
        '<span class="locale__name">English</span>' +
        '<svg class="locale__caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 9l7 7 7-7"/></svg>' +
      "</button>" +
      '<div class="locale__panel" id="locale-list" role="group" aria-label="Languages"></div>';

    localeBtn = host.querySelector(".locale__btn");
    localeName = host.querySelector(".locale__name");
    localePanel = host.querySelector("#locale-list");

    /* One column per run, so the whole list is on screen instead of behind a
       scroll; the device's own languages lead it when we can serve any. */
    var runs = GROUPS.slice();
    var prefs = prefCodes();
    if (prefs.length) {
      runs = [[SUGGEST, prefs.map(function (c) { return [c, NAMES[c]]; })]].concat(runs);
    }
    runs.forEach(function (g, gi) {
      var col = document.createElement("div");
      col.className = "locale__col" + (prefs.length && gi === 0 ? " locale__col--suggest" : "");
      col.setAttribute("role", "group");
      col.setAttribute("aria-labelledby", "locale-g" + gi);
      var head = document.createElement("p");
      head.className = "locale__group";
      head.id = "locale-g" + gi;
      head.textContent = g[0];
      if (prefs.length && gi === 0) suggestHead = head;
      col.appendChild(head);
      g[1].forEach(function (l) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "locale__opt";
        b.setAttribute("data-code", l[0]);
        b.setAttribute("aria-current", "false");
        b.textContent = l[1];
        b.addEventListener("click", function () { apply(l[0]); close(); localeBtn.focus(); });
        col.appendChild(b);
      });
      localePanel.appendChild(col);
    });
    localePanel.addEventListener("keydown", function (e) {
      var opts = Array.prototype.slice.call(localePanel.querySelectorAll(".locale__opt"));
      var at = opts.indexOf(document.activeElement);
      var step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (!step || at < 0) return;
      e.preventDefault();
      opts[(at + step + opts.length) % opts.length].focus();
    });

    /* How wide the pane has to be for the whole list to be visible at once. The row
       height is measured from a real option rather than assumed, and the column count
       is capped by what fits across the screen — past that the pane scrolls, which is
       still better than a language nobody can reach. Mirrors the --locale-col-w the
       panel's own width calc uses. */
    function fitColumns() {
      var opts = localePanel.querySelectorAll(".locale__opt");
      var heads = localePanel.querySelectorAll(".locale__group");
      if (!opts.length) return;
      var st = getComputedStyle(localePanel);
      var row = opts[0].offsetHeight || 34;
      var head = (heads[0] && heads[0].offsetHeight) || 28;
      var colW = parseFloat(st.getPropertyValue("--locale-col-w")) || 154;
      var gap = parseFloat(st.columnGap) || 12;
      var pad = (parseFloat(st.paddingLeft) || 0) + (parseFloat(st.paddingRight) || 0);
      var notice = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--cookie-h")) || 0;
      var perCol = Math.max(4, Math.floor((innerHeight - 104 - notice - pad - head) / row));
      var widest = Math.max(2, Math.floor((Math.min(innerWidth * 0.94, 1040) - pad + gap) / (colW + gap)));
      localePanel.style.setProperty("--locale-cols",
        String(Math.max(2, Math.min(Math.ceil((opts.length + heads.length) / perCol), widest))));
      anchor();
    }

    /* The sheet is pinned to the viewport, so the script has to say where: under
       the button, and pulled back inside the window when the button sits near the
       right edge. The width only exists after --locale-cols has been read, hence
       the offsetWidth in between. */
    function anchor() {
      var a = localeBtn.getBoundingClientRect();
      localePanel.style.setProperty("--locale-top", Math.round(a.bottom + 6) + "px");
      var w = localePanel.offsetWidth;
      localePanel.style.setProperty("--locale-left",
        String(Math.max(8, Math.round(Math.min(a.left, innerWidth - w - 8)))) + "px");
    }

    localeBtn.addEventListener("click", function () {
      var willOpen = !host.classList.contains("is-open");
      host.classList.toggle("is-open", willOpen);
      localeBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
      if (willOpen) fitColumns();
    });
    window.addEventListener("resize", function () {
      if (host.classList.contains("is-open")) fitColumns();
    }, { passive: true });
    /* This sheet used to shut the moment the page scrolled, because scrolling
       folded the utility row away and left the sheet hanging over nothing. The
       row is pinned with the nav now, so it never moves out from under the sheet
       and there is nothing to close on — the listener went with it. */
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") close();
    });
    document.addEventListener("pointerdown", function (e) {
      if (!host.contains(e.target)) close();
    });
    document.addEventListener("i18n-applied", function () {
      if (localeBtn) localeBtn.setAttribute("aria-label", t("Choose language"));
      if (suggestHead) suggestHead.textContent = t(SUGGEST);
    });
    sync();
  }

  function close() {
    if (!localeBtn) return;
    var host = localeBtn.parentNode;
    host.classList.remove("is-open");
    localeBtn.setAttribute("aria-expanded", "false");
  }

  // The button names the current language, and every option carries the same
  // English name, so collect() excludes the whole pane from translation.
  function sync() {
    if (!localeBtn) return;
    var name = "English";
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i][0] === current) name = LANGS[i][1];
    localeName.textContent = name;
    Array.prototype.forEach.call(localePanel.querySelectorAll(".locale__opt"), function (b) {
      var on = b.getAttribute("data-code") === current;
      b.classList.toggle("is-current", on);
      b.setAttribute("aria-current", on ? "true" : "false");
    });
  }

  // Fold any browser or query tag onto a code we can serve: exact, then aliased,
  // then the subtags of a region tag such as "es-419" or "zh-Hans-CN".
  function resolve(tag) {
    var t = String(tag || "").trim().toLowerCase().replace(/_/g, "-");
    if (!t) return "";
    var parts = t.split("-");
    for (var i = 0; i < parts.length; i++) {
      if (CODES[parts[i]]) return parts[i];
      var alias = ALIAS[parts[i]];
      if (alias && CODES[alias]) return alias;
    }
    if (CODES[t]) return t;
    if (ALIAS[t] && CODES[ALIAS[t]]) return ALIAS[t];
    return "";
  }

  // Every language the device asks for that we can actually serve, in the order
  // it lists them. English is left out: it is what the page already is.
  function prefCodes() {
    var prefs = (navigator.languages && navigator.languages.length)
      ? navigator.languages : [navigator.language || ""];
    var out = [], taken = {};
    for (var i = 0; i < prefs.length; i++) {
      var hit = resolve(prefs[i]);
      if (hit && hit !== "en" && !taken[hit]) { taken[hit] = 1; out.push(hit); }
    }
    return out;
  }

  // The whole preferred-language list, not just its first entry: a Ghanaian
  // browser commonly offers [en, tw] and Twi is the one worth serving.
  function firstPref() {
    return prefCodes()[0] || "en";
  }

  function init() {
    buildLocale();

    records.metaTitle = document.title;
    var md = document.querySelector('meta[name="description"]');
    if (md) { records.metaDesc = md; records.metaDescOrig = md.getAttribute("content"); }

    collect(document.body);

    // Three sources, highest first: the address, the choice this browser already
    // recorded, then the operating system's language list. A ?lang= link is what
    // a shared or indexed address promises, so it wins and stays remembered.
    var wanted = "en";
    try {
      var q = new URLSearchParams(window.location.search).get("lang");
      wanted = resolve(q) || resolve(localStorage.getItem("brownhub-lang")) || firstPref();
    } catch (e) {}
    if (wanted !== "en") apply(wanted);

    var pending = [];
    var timer = null;
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        for (var i = 0; i < m.addedNodes.length; i++) pending.push(m.addedNodes[i]);
      });
      if (!pending.length || timer) return;
      // A timeout, not an animation frame: modals injected while the tab is in
      // the background would otherwise wait until the visitor looks back.
      timer = setTimeout(function () {
        timer = null;
        var nodes = pending; pending = [];
        nodes.forEach(function (n) { window.I18N.translateNode(n); });
      }, 80);
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
