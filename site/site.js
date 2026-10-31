// Page behavior: nav and menu, the Download panel, the setup prompt copy, the Softies (inline, blinking, eyes that
// follow the pointer), the model picker and the take-over demo. Nothing moves on its own except the Softies' blink.
(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

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
    menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };
  menuBtn?.addEventListener("click", () => setMenu(menu.hidden));
  menu?.addEventListener("click", (e) => {
    if (e.target.closest("a, button")) setMenu(false);
  });

  // The team's hop-in plays once per visit (index.html sets .intro); drop the class once it's done.
  if (document.documentElement.classList.contains("intro"))
    setTimeout(() => document.documentElement.classList.remove("intro"), 1400);

  // ------------------------------------------------------------- Copying
  // Clipboard API first, then execCommand. `returnFocus`: where the focus goes after the old-style copy.
  const copyText = async (text, returnFocus) => {
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
    returnFocus?.focus({ preventScroll: true });
    return ok;
  };

  // "Copy a setup prompt" (in the Mac download panel): a one-line prompt for Claude Code or Codex. If copying
  // fails, the text shows selected in a field so the visitor can copy it by hand.
  const setupBtn = document.querySelector("[data-setup-copy]");
  const setupNote = document.querySelector("[data-setup-note]");
  const setupFallback = document.querySelector("[data-setup-fallback]");
  let setupTimer;
  setupBtn?.addEventListener("click", async () => {
    const text = setupBtn.dataset.copyText;
    const ok = await copyText(text, setupBtn);
    clearTimeout(setupTimer);
    if (ok) {
      setupFallback.hidden = true;
      setupNote.classList.remove("is-manual");
      setupNote.textContent = "Copied. Paste it into Claude Code or Codex.";
      setupTimer = setTimeout(() => {
        setupNote.textContent = "";
      }, 4000);
    } else {
      setupFallback.value = text;
      setupFallback.hidden = false;
      setupFallback.focus();
      setupFallback.select();
      setupNote.classList.add("is-manual");
      setupNote.textContent =
        "Couldn't copy automatically. Press ⌘C, then paste it into Claude Code or Codex.";
    }
  });

  // ------------------------------------------------- First open (FAQ entry)
  const openFaq = (id) => {
    const d = document.getElementById(id);
    if (d?.tagName === "DETAILS") d.open = true;
  };
  for (const a of $$('a[href^="#"]')) {
    const id = a.getAttribute("href").slice(1);
    if (document.getElementById(id)?.tagName === "DETAILS") a.addEventListener("click", () => openFaq(id));
  }
  if (location.hash) openFaq(location.hash.slice(1));

  // ------------------------------------------------------ Download (.dmg)
  // Every Download link points at one release page, which works with JavaScript off. DOWNLOAD_TAG in config.js
  // pins that release (GitHub /releases/tags/<tag>); leave it "" for /releases/latest.
  // With JS, a click on a Mac starts the .dmg itself, found through GitHub's public API (CORS, no token;
  // looked up once after load and cached), and a small panel says what to do next. Windows and Linux get a
  // panel with the one-line install command for their system instead (phones, tablets and anything we can't
  // tell get both, labelled). Those commands are the text in the page, so they name the same tag. If GitHub
  // doesn't answer or the release has no .dmg, a Mac's link just opens the release page as before.
  const downloadTag = (() => {
    const raw = String(window.YO_SITE?.DOWNLOAD_TAG ?? "").trim();
    return /^v\d+\.\d+\.\d+$/.test(raw) ? raw : "";
  })();
  const RELEASE_API = downloadTag
    ? `https://api.github.com/repos/JuniorSua/yo-app/releases/tags/${downloadTag}`
    : "https://api.github.com/repos/JuniorSua/yo-app/releases/latest";
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
  if (document.querySelector("[data-download]")) {
    if ("requestIdleCallback" in window) requestIdleCallback(findDmg, { timeout: 2500 });
    else setTimeout(findDmg, 800);
  }

  // "mac" gets the .dmg; "windows" and "linux" get their install command; "both" (phones, tablets, ChromeOS and
  // anything else) sees both commands. iPhones say "like Mac OS X" and iPads say "Macintosh" (but have touch).
  const os = (() => {
    const platform = navigator.userAgentData?.platform;
    if (platform) {
      if (platform === "macOS") return "mac";
      if (platform === "Windows") return "windows";
      if (platform === "Linux") return "linux";
      return "both";
    }
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod|Android|CrOS/i.test(ua)) return "both";
    if (/Macintosh/.test(ua)) return navigator.maxTouchPoints > 1 ? "both" : "mac";
    if (/Windows/.test(ua)) return "windows";
    if (/Linux|X11/.test(ua)) return "linux";
    return "both";
  })();
  const isMac = os === "mac";

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
    panel.classList.toggle("is-pc", mode !== "mac");
    panel.setAttribute("aria-labelledby", mode === "mac" ? "dl-title-mac" : "dl-title-other");
    panelAnchor = anchor;
    panelReturn = anchor;
    panel.hidden = false;
    placePanel();
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
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    openFaq(a.getAttribute("href").slice(1));
    closePanel({ restoreFocus: false });
  });

  // Windows and Linux: show this computer's install command (or both), each with a Copy button. If copying
  // doesn't work, the command is selected on the page so Ctrl+C copies it.
  for (const n of panel?.querySelectorAll("[data-os]") ?? [])
    n.hidden = !n.dataset.os.split(" ").includes(os);
  const dlNote = panel?.querySelector("[data-dl-note]");
  let dlTimer;
  for (const btn of panel?.querySelectorAll("[data-dl-copy]") ?? []) {
    btn.addEventListener("click", async () => {
      const code = btn.closest(".dl-cmd").querySelector("code");
      const label = btn.querySelector("[data-dl-copy-label]");
      const ok = await copyText(code.textContent.trim(), btn);
      clearTimeout(dlTimer);
      for (const b of panel.querySelectorAll("[data-dl-copy]")) {
        b.classList.remove("is-copied");
        b.querySelector("[data-dl-copy-label]").textContent = "Copy";
      }
      dlNote.classList.toggle("is-manual", !ok);
      if (ok) {
        btn.classList.add("is-copied");
        label.textContent = "Copied";
        dlNote.textContent = btn.closest(".dl-cmd").dataset.os.startsWith("windows")
          ? "Copied. Paste it in PowerShell (right-click, or Ctrl+V), then press Enter."
          : "Copied. Paste it in the terminal (Ctrl+Shift+V), then press Enter.";
        dlTimer = setTimeout(() => {
          btn.classList.remove("is-copied");
          label.textContent = "Copy";
          dlNote.textContent = "";
        }, 4000);
      } else {
        getSelection()?.selectAllChildren(code);
        dlNote.textContent = "Couldn't copy automatically. It's selected: press Ctrl+C to copy it.";
      }
    });
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const link of $$("[data-download]")) {
    link.addEventListener("click", async (e) => {
      // Cmd/Ctrl/Shift-click and middle-click keep doing what the visitor asked for (a new tab, say).
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      if (!isMac) {
        findDmg();
        openPanel("pc", link);
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

  // ------------------------------------------------------------ Softies
  // Each [data-softie] holds an <img> of a Softie (works without JavaScript). Swap it for the same SVG inline,
  // with its own ids, so the eyes can blink (CSS) and, in the hero, follow the pointer.
  const svgText = new Map();
  const load = (src) => {
    if (!svgText.has(src))
      svgText.set(
        src,
        fetch(src)
          .then((r) => (r.ok ? r.text() : null))
          .catch(() => null),
      );
    return svgText.get(src);
  };
  let uid = 0;
  const live = $$("[data-softie]");
  Promise.all(
    live.map(async (box) => {
      const img = box.querySelector("img");
      const text = img && (await load(img.getAttribute("src")));
      if (!text?.startsWith("<svg")) return;
      const n = uid++;
      box.innerHTML = text.replace(/(id="|url\(#)([A-Za-z0-9_-]+)/g, `$1$2-${n}`);
      const svg = box.querySelector("svg");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      svg.style.setProperty("--d", `${-((n * 1.37) % 5.2).toFixed(2)}s`);
    }),
  ).then(() => {
    if (!reduceMotion) follow();
  });

  // The hero team and the chat's head glance toward the pointer. Mapped 1:1 to the pointer, so it only moves
  // when the visitor does.
  function follow() {
    const lookers = [...$$(".team [data-softie]"), ...$$("[data-look]")];
    if (!lookers.length || !window.matchMedia("(hover: hover)").matches) return;
    let px = 0;
    let py = 0;
    let queued = false;
    const clamp = (v) => Math.max(-1, Math.min(1, v));
    const look = () => {
      queued = false;
      for (const box of lookers) {
        const eyes = box.querySelector(".av-gaze");
        if (!eyes) continue;
        const r = box.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) continue;
        const dx = (px - (r.left + r.width / 2)) / 520;
        const dy = (py - (r.top + r.height / 2)) / 420;
        eyes.style.transform = `translate(${(clamp(dx) * 3.2).toFixed(2)}px, ${(clamp(dy) * 2.6).toFixed(2)}px)`;
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
  }

  // -------------------------------------------------------- Model picker
  // "Change a dropdown": each agent's chip opens the provider list under its row; picking one changes the chip.
  const picker = document.querySelector("[data-picker]");
  if (picker) {
    const panelEl = picker.querySelector("[data-menu-panel]");
    const agentEl = picker.querySelector("[data-menu-agent]");
    const note = picker.querySelector("[data-picker-note]");
    const NAMES = { claude: "Claude", chatgpt: "ChatGPT", grok: "Grok" };
    let row = picker.querySelector(".picker-row.is-open");
    const chipOf = (r) => r.querySelector("[data-chip]");
    const providerOf = (r) =>
      chipOf(r)
        .querySelector(".pv")
        .className.match(/pv-(\w+)/)[1];
    const sync = () => {
      for (const input of panelEl.querySelectorAll("input")) input.checked = input.value === providerOf(row);
    };
    const open = (r) => {
      for (const other of picker.querySelectorAll(".picker-row")) {
        other.classList.toggle("is-open", other === r);
        chipOf(other).setAttribute("aria-expanded", String(other === r));
      }
      row = r;
      if (!r) {
        panelEl.hidden = true;
        return;
      }
      agentEl.textContent = r.dataset.agent;
      r.after(panelEl);
      panelEl.hidden = false;
      panelEl.classList.remove("is-in");
      void panelEl.offsetWidth;
      panelEl.classList.add("is-in");
      sync();
    };
    for (const r of picker.querySelectorAll(".picker-row"))
      chipOf(r).addEventListener("click", () => open(row === r && !panelEl.hidden ? null : r));
    panelEl.addEventListener("change", (e) => {
      const value = e.target.value;
      if (!row || !NAMES[value]) return;
      const chip = chipOf(row);
      chip.querySelector(".pv").className = `pv pv-${value}`;
      chip.querySelector("[data-chip-label]").textContent = NAMES[value];
      note.innerHTML = "";
      const b = document.createElement("b");
      b.textContent = `${row.dataset.agent} now uses ${NAMES[value]}.`;
      note.append(b, " Same name, same memory, same work.");
    });
    panelEl.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !row) return;
      const r = row;
      open(null);
      chipOf(r).focus();
    });
  }

  // ------------------------------------------------- Take over (computer)
  const pc = document.querySelector("[data-pc]");
  if (pc) {
    const toggle = pc.querySelector("[data-pc-toggle]");
    const label = pc.querySelector("[data-pc-label]");
    toggle.addEventListener("click", () => {
      const yours = !pc.classList.contains("is-yours");
      pc.classList.toggle("is-yours", yours);
      toggle.setAttribute("aria-pressed", String(yours));
      toggle.textContent = yours ? "Hand back" : "Take over";
      label.innerHTML = yours ? "<b>You</b> have control" : "<b>Kiki</b> has control";
    });
  }
})();
