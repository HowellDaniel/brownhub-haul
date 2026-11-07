const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = matchMedia("(pointer: fine)");

function initMotion() {
  const reveals = [...document.querySelectorAll("[data-reveal]")];
  document.body.classList.add("motion-ready");

  if (reduced.matches || !("IntersectionObserver" in window)) {
    reveals.forEach((el) => el.classList.add("is-visible"));
  } else {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    reveals.forEach((el, index) => {
      el.style.setProperty("--reveal-delay", `${Math.min(index % 3, 2) * 70}ms`);
      observer.observe(el);
    });
  }

  initHeadline();
  initCounters();
  initAirportVideo();
  if (!reduced.matches) {
    initScrollEffects();
    if (finePointer.matches) initTilt();
  }
}

function initHeadline() {
  const lines = [...document.querySelectorAll("[data-split]")];
  for (const line of lines) {
    const text = line.textContent;
    line.setAttribute("aria-label", text);
    line.textContent = "";
    [...text].forEach((char, index) => {
      const span = document.createElement("span");
      span.className = "split-char";
      span.setAttribute("aria-hidden", "true");
      span.style.setProperty("--char-index", index);
      span.textContent = char === " " ? " " : char;
      line.append(span);
    });
  }
  requestAnimationFrame(() => document.querySelector(".hero")?.classList.add("is-in"));
}

function initCounters() {
  const counters = [...document.querySelectorAll("[data-count]")];
  const finish = (el) => {
    el.textContent = `${el.dataset.prefix || ""}${Number(el.dataset.count).toLocaleString("en-GH")}${el.dataset.suffix || ""}`;
  };
  if (reduced.matches || !("IntersectionObserver" in window)) {
    counters.forEach(finish);
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const el = entry.target;
      const target = Number(el.dataset.count);
      const start = performance.now();
      const tick = (now) => {
        const progress = Math.min(1, (now - start) / 1100);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = `${el.dataset.prefix || ""}${Math.round(target * eased).toLocaleString("en-GH")}${el.dataset.suffix || ""}`;
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  }, { threshold: 0.5 });
  counters.forEach((el) => observer.observe(el));
}

function initScrollEffects() {
  const hero = document.querySelector(".hero");
  const zooms = [...document.querySelectorAll(".image-zoom")];
  let queued = false;
  const update = () => {
    queued = false;
    const y = window.scrollY;
    if (hero && y < innerHeight * 1.3) {
      hero.style.setProperty("--hero-y", `${Math.min(y * 0.18, 110)}px`);
      hero.style.setProperty("--hero-light-x", `${Math.min(y * 0.035, 34)}px`);
    }
    for (const figure of zooms) {
      const rect = figure.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight) continue;
      const centre = rect.top + rect.height / 2;
      const distance = Math.abs(centre - innerHeight / 2) / (innerHeight + rect.height);
      figure.style.setProperty("--scroll-scale", (1.025 + Math.min(distance * 0.13, 0.065)).toFixed(3));
    }
  };
  const requestUpdate = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };
  addEventListener("scroll", requestUpdate, { passive: true });
  addEventListener("resize", requestUpdate, { passive: true });
  update();
}

function initTilt() {
  for (const card of document.querySelectorAll("[data-tilt]")) {
    card.addEventListener("pointermove", (event) => {
      const rect = card.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      card.style.setProperty("--tilt-x", `${(-y * 4).toFixed(2)}deg`);
      card.style.setProperty("--tilt-y", `${(x * 5).toFixed(2)}deg`);
    });
    card.addEventListener("pointerleave", () => {
      card.style.setProperty("--tilt-x", "0deg");
      card.style.setProperty("--tilt-y", "0deg");
    });
  }
}

function initAirportVideo() {
  const videos = [...document.querySelectorAll("[data-airport-video]")];
  if (!videos.length) return;
  const saveData = navigator.connection?.saveData;
  const constrained = (navigator.hardwareConcurrency || 4) <= 2;
  if (reduced.matches || saveData || constrained) return;

  const tryPlay = (v) => v.play().then(() => v.classList.add("is-live")).catch(() => {});

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const v = entry.target;
      if (entry.isIntersecting) {
        if (reduced.matches) return;
        if (!v.src && v.dataset.src) {
          v.src = v.dataset.src;
          v.load();
          v.playbackRate = 0.65;
        }
        tryPlay(v);
      } else {
        v.pause();
        v.classList.remove("is-live");
      }
    }
  }, { rootMargin: "200px 0px", threshold: 0.1 });

  for (const v of videos) {
    v.addEventListener("loadedmetadata", () => { v.playbackRate = 0.65; });
    v.addEventListener("loadeddata", () => { if (!v.paused) return; if (v.getBoundingClientRect().top < innerHeight + 200) tryPlay(v); });
  }
  const start = () => {
    if (reduced.matches) return;
    videos.forEach((v) => observer.observe(v));
  };
  reduced.addEventListener("change", () => {
    if (!reduced.matches) return;
    for (const v of videos) { v.pause(); v.removeAttribute("src"); v.load(); v.classList.remove("is-live"); }
  });
  setTimeout(start, 500);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initMotion, { once: true });
else initMotion();
