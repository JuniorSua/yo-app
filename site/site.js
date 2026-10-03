// Page behavior: reveal on scroll, nav, menu, dialog, the living mascot, the "Yo, …" ask boxes, and small loops.
(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  // ------------------------------------------------------------- Reveal
  const items = $$(".reveal");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.06 },
    );
    for (const n of items) {
      const sibs = [...n.parentElement.children].filter((c) => c.classList.contains("reveal"));
      n.style.transitionDelay = `${Math.min(sibs.indexOf(n), 5) * 70}ms`;
      io.observe(n);
    }
  } else {
    for (const n of items) n.classList.add("is-in");
  }

  // ---------------------------------------------------------------- Nav
  const nav = document.querySelector("[data-nav]");
  const onScroll = () => nav?.classList.toggle("is-scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const menuBtn = document.querySelector("[data-menu]");
  const menu = document.querySelector("[data-mobile-menu]");
  const setMenu = (open) => {
    menu.hidden = !open;
    menuBtn.setAttribute("aria-expanded", String(open));
  };
  menuBtn?.addEventListener("click", () => setMenu(menu.hidden));
  menu?.addEventListener("click", (e) => {
    if (e.target.closest("a, button")) setMenu(false);
  });

  // ------------------------------------------------- "Set up with your agent"
  // Copies a one-line prompt for Claude Code or Codex. Falls back to execCommand, and if that fails too, shows
  // the text selected in a field so the visitor can copy it by hand.
  const setupBtn = document.querySelector("[data-setup-copy]");
  const setupNote = document.querySelector("[data-setup-note]");
  const setupFallback = document.querySelector("[data-setup-fallback]");
  let setupTimer;
  const copyText = async (text) => {
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Permission denied or no focus: try the old way below.
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    setupBtn?.focus();
    return ok;
  };
  setupBtn?.addEventListener("click", async () => {
    const text = setupBtn.dataset.copyText;
    const ok = await copyText(text);
    clearTimeout(setupTimer);
    if (ok) {
      setupFallback.hidden = true;
      setupBtn.classList.add("is-copied");
      setupNote.textContent = "Copied: paste it into Claude Code or Codex";
      setupTimer = setTimeout(() => {
        setupBtn.classList.remove("is-copied");
        setupNote.textContent = "";
      }, 4000);
    } else {
      setupFallback.value = text;
      setupFallback.hidden = false;
      setupFallback.focus();
      setupFallback.select();
      setupNote.textContent =
        "Couldn't copy automatically. Press ⌘C to copy, then paste it into Claude Code or Codex.";
    }
  });

  // ------------------------------------------------------- $10 Payment Link
  // The button only appears when config.js has a real Stripe Payment Link. Otherwise "coming soon" stays.
  const payUrl = (() => {
    const raw = String(window.YO_SITE?.STRIPE_PAYMENT_LINK ?? "").trim();
    if (!raw) return null;
    try {
      const u = new URL(raw);
      const ok =
        u.protocol === "https:" &&
        u.hostname === "buy.stripe.com" &&
        !u.port &&
        !u.username &&
        !u.password &&
        /^\/[A-Za-z0-9_-]+$/.test(u.pathname);
      return ok ? u.href : null;
    } catch {
      return null;
    }
  })();
  if (payUrl) {
    for (const a of $$("[data-pay]")) {
      a.href = payUrl;
      a.hidden = false;
    }
    for (const n of $$("[data-pay-soon]")) n.hidden = true;
  }

  // ------------------------------------------------- First open (FAQ entry)
  const openFirstOpen = () => {
    const d = document.getElementById("first-open");
    if (d) d.open = true;
  };
  for (const a of $$('a[href="#first-open"]')) a.addEventListener("click", openFirstOpen);
  if (location.hash === "#first-open") openFirstOpen();

  // ------------------------------------------------------ Download (.dmg)
  // Every Download link points at the latest release page (works without JS). With JS, a click on a Mac starts
  // the .dmg itself, found through GitHub's public API (CORS, no token; looked up once after load and cached),
  // and a small panel says what to do next. Other computers get a "Mac-only for now" panel instead. If GitHub
  // doesn't answer or the release has no .dmg, the link just opens the release page as before.
  const RELEASE_API = "https://api.github.com/repos/JuniorSua/yo-app/releases/latest";
  const DMG_PATH = "/JuniorSua/yo-app/releases/download/";
  const isDmgUrl = (raw) => {
    try {
      const u = new URL(raw);
      return (
        u.protocol === "https:" &&
        u.hostname === "github.com" &&
        !u.port &&
        !u.username &&
        !u.password &&
        u.pathname.startsWith(DMG_PATH) &&
        u.pathname.endsWith(".dmg")
      );
    } catch {
      return false;
    }
  };
  let dmg = null; // { url, name } once found
  let dmgLookup = null;
  const findDmg = () => {
    dmgLookup ??= fetch(RELEASE_API)
      .then((r) => (r.ok ? r.json() : null))
      .then((release) => {
        const asset = (Array.isArray(release?.assets) ? release.assets : []).find(
          (a) =>
            typeof a?.name === "string" && a.name.endsWith("-arm64.dmg") && isDmgUrl(a.browser_download_url),
        );
        if (!asset) return null;
        dmg = { url: asset.browser_download_url, name: asset.name };
        for (const a of $$("[data-dl-direct]")) a.href = dmg.url;
        for (const n of $$("[data-dl-name]")) n.textContent = dmg.name;
        return dmg;
      })
      .catch(() => null)
      .then((found) => {
        if (!found) dmgLookup = null; // let the next click ask again
        return found;
      });
    return dmgLookup;
  };
  if ("requestIdleCallback" in window) requestIdleCallback(findDmg, { timeout: 2500 });
  else setTimeout(findDmg, 800);

  // Yo is Mac-only for now. iPhones say "like Mac OS X" and iPads say "Macintosh" (but have touch).
  const isMac = (() => {
    const platform = navigator.userAgentData?.platform;
    if (platform) return platform === "macOS";
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod|Android/i.test(ua)) return false;
    return /Macintosh/.test(ua) && !(navigator.maxTouchPoints > 1);
  })();

  const panel = document.querySelector("[data-dl-panel]");
  let panelAnchor = null;
  let panelReturn = null;
  const placePanel = () => {
    if (!panel || panel.hidden) return;
    const r = panelAnchor?.getBoundingClientRect();
    // Phones, and a link that's gone (the mobile menu closes on click): a sheet along the bottom.
    const sheet = window.innerWidth < 640 || !r || (r.width === 0 && r.height === 0);
    panel.classList.toggle("is-sheet", sheet);
    if (sheet) {
      panel.style.top = "";
      panel.style.left = "";
      return;
    }
    const m = 16;
    const gap = 10;
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    let top = r.bottom + gap;
    if (top + h > window.innerHeight - m && r.top - gap - h >= m) top = r.top - gap - h;
    top = Math.max(m, Math.min(top, window.innerHeight - h - m));
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(Math.max(m, Math.min(r.left, window.innerWidth - w - m)))}px`;
  };
  const openPanel = (mode, anchor) => {
    if (!panel) return;
    panel.querySelector("[data-dl-mac]").hidden = mode !== "mac";
    panel.querySelector("[data-dl-other]").hidden = mode === "mac";
    panel.setAttribute("aria-labelledby", mode === "mac" ? "dl-title-mac" : "dl-title-other");
    panelAnchor = anchor;
    panelReturn = anchor;
    panel.hidden = false;
    placePanel();
    // No room under the link (the hero's Download near the fold): scroll a little so the panel can sit below it
    // instead of covering the "Set up with your agent" chip above.
    if (!panel.classList.contains("is-sheet")) {
      const r = anchor.getBoundingClientRect();
      const short = Math.ceil(r.bottom + 10 + panel.offsetHeight + 16 - window.innerHeight) + 8;
      const room = r.top - 96; // stay clear of the sticky nav
      if (short > 0 && short <= room)
        window.scrollBy({ top: short, behavior: reduceMotion ? "auto" : "smooth" });
    }
    panel.classList.remove("is-in");
    void panel.offsetWidth; // restart the entrance animation
    panel.classList.add("is-in");
    panel.focus({ preventScroll: true });
  };
  const closePanel = ({ restoreFocus = true } = {}) => {
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    if (restoreFocus && panelReturn?.isConnected && panelReturn.offsetParent !== null)
      panelReturn.focus({ preventScroll: true });
    panelAnchor = null;
    panelReturn = null;
  };
  let placeQueued = false;
  const queuePlace = () => {
    if (placeQueued || !panel || panel.hidden) return;
    placeQueued = true;
    requestAnimationFrame(() => {
      placeQueued = false;
      placePanel();
    });
  };
  window.addEventListener("scroll", queuePlace, { passive: true });
  window.addEventListener("resize", queuePlace);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel && !panel.hidden) closePanel();
  });
  document.addEventListener("pointerdown", (e) => {
    if (panel && !panel.hidden && !panel.contains(e.target) && !e.target.closest?.("[data-download]"))
      closePanel({ restoreFocus: false });
  });
  panel?.querySelector("[data-dl-close]").addEventListener("click", () => closePanel());
  panel?.addEventListener("click", (e) => {
    if (e.target.closest('a[href^="#"]')) closePanel({ restoreFocus: false });
  });
  panel?.querySelector("[data-dl-setup]").addEventListener("click", () => {
    closePanel({ restoreFocus: false });
    if (!setupBtn) return;
    setupBtn.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    setupBtn.focus({ preventScroll: true });
    setupBtn.classList.remove("is-nudged");
    void setupBtn.offsetWidth;
    setupBtn.classList.add("is-nudged");
  });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const link of $$("[data-download]")) {
    link.addEventListener("click", async (e) => {
      // Cmd/Ctrl/Shift-click and middle-click keep doing what the visitor asked for (a new tab, say).
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (!isMac) {
        findDmg();
        openPanel("other", link);
        return;
      }
      const found = dmg ?? (await Promise.race([findDmg(), wait(3000)]));
      if (!found) {
        location.assign(link.href);
        return;
      }
      openPanel("mac", link);
      // A download: the browser saves it and this page stays put.
      location.assign(found.url);
    });
  }

  // ------------------------------------------------------------ Mascot
  // Swap each <img> logo for inline SVG so the eyes can follow the pointer and blink.
  const mascots = $$("[data-mascot]");
  fetch("/assets/logo.svg")
    .then((r) => r.text())
    .then((svg) => {
      mascots.forEach((m, i) => {
        // Give each copy its own gradient and clip ids so they don't collide.
        m.innerHTML = svg.replace(/(id="|url\(#)([a-zA-Z0-9]+)/g, `$1$2m${i}`);
        m.querySelector("svg")?.removeAttribute("width");
        m.querySelector("svg")?.removeAttribute("height");
      });
      if (!reduceMotion) startMascots();
    })
    .catch(() => {});

  function startMascots() {
    let px = window.innerWidth / 2;
    let py = window.innerHeight / 3;
    let queued = false;
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    const look = () => {
      queued = false;
      for (const m of mascots) {
        const eyes = m.querySelector(".yo-av-look");
        if (!eyes) continue;
        const r = m.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) continue;
        const dx = (px - (r.left + r.width / 2)) / Math.max(r.width * 2.5, 260);
        const dy = (py - (r.top + r.height / 2)) / Math.max(r.height * 2.5, 260);
        eyes.style.transform = `translate(${clamp(dx) * 4.5}px, ${clamp(dy) * 3.5}px)`;
      }
    };
    window.addEventListener(
      "pointermove",
      (e) => {
        px = e.clientX;
        py = e.clientY;
        if (!queued) {
          queued = true;
          requestAnimationFrame(look);
        }
      },
      { passive: true },
    );
    const blink = () => {
      for (const m of mascots) {
        m.classList.add("is-blinking");
        setTimeout(() => m.classList.remove("is-blinking"), 200);
      }
      setTimeout(blink, 2800 + Math.random() * 3200);
    };
    setTimeout(blink, 2000);
  }

  // ---------------------------------------------------------- Ask boxes
  const TASKS = [
    "book dinner for 4 on friday",
    "reorder my coffee beans, cheaper if you can",
    "clean up my inbox",
    "plan a long weekend in lisbon",
    "clear my tuesday and tell people",
    "compare standing desks under $700",
  ];

  function goToDemo() {
    document
      .querySelector("[data-desk]")
      ?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }

  function sendToDemo(text) {
    goToDemo();
    setTimeout(() => window.yoDemo?.ask(text), reduceMotion ? 0 : 650);
  }

  $$("[data-ask]").forEach((form, n) => {
    const input = form.querySelector("[data-ask-input]");
    if (reduceMotion) {
      input.placeholder = TASKS[(n * 2) % TASKS.length];
    } else {
      // Types example tasks into the placeholder while the box is empty and idle.
      let task = n * 2;
      let i = 0;
      let deleting = false;
      const tick = () => {
        const full = TASKS[task % TASKS.length];
        if (document.activeElement === input || input.value) {
          input.placeholder = full;
          return setTimeout(tick, 600);
        }
        if (!deleting) {
          i += 1;
          input.placeholder = full.slice(0, i);
          if (i >= full.length) {
            deleting = true;
            return setTimeout(tick, 1800);
          }
          return setTimeout(tick, 42 + Math.random() * 40);
        }
        i -= 1;
        input.placeholder = full.slice(0, i) || " ";
        if (i <= 0) {
          deleting = false;
          task += 1;
          return setTimeout(tick, 350);
        }
        return setTimeout(tick, 22);
      };
      setTimeout(tick, 600 + n * 400);
    }
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim() || input.placeholder.trim() || TASKS[0];
      input.value = "";
      input.blur();
      sendToDemo(text);
    });
  });

  for (const b of $$("[data-ask-chips] button")) b.addEventListener("click", () => sendToDemo(b.textContent));

  for (const b of $$("[data-open-agent]")) {
    b.addEventListener("click", () => {
      goToDemo();
      window.yoDemo?.open(b.dataset.openAgent);
    });
  }

  // --------------------------------------------------------- Small loops
  if (reduceMotion) return;

  const feed = $$("[data-feed] .feed-card");
  let fresh = 0;
  setInterval(() => {
    const visible = feed.filter((c) => c.offsetParent !== null);
    if (!visible.length) return;
    for (const c of feed) c.classList.remove("is-fresh");
    visible[fresh % visible.length].classList.add("is-fresh");
    fresh += 1;
  }, 2400);

  const planRows = $$("[data-viz-plan] .vp-row");
  let plan = 0;
  setInterval(() => {
    plan = (plan + 1) % planRows.length;
    planRows.forEach((r, i) => {
      r.classList.toggle("is-on", i === plan);
    });
  }, 2200);

  const url = document.querySelector("[data-vc-url]");
  const URLS = [
    "opentable.com/r/juniper-and-rye",
    "grovemarket.com/checkout",
    "mail.google.com",
    "google.com/travel/flights",
  ];
  let u = 0;
  setInterval(() => {
    u = (u + 1) % URLS.length;
    if (url) url.textContent = URLS[u];
  }, 4800);
})();
