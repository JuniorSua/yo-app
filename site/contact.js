// Owner settings shown on every page: the support email.
//
// Lines marked [data-email-only] stay hidden until config.js has an address; then each [data-support-email] link
// gets it (and shows it, with [data-show-address]), and [data-no-email] lines (the "no email yet" wording) hide.
// Anything that doesn't look like an email is ignored.
(() => {
  const raw = String(window.YO_SITE?.SUPPORT_EMAIL ?? "").trim();
  if (!/^[^\s@<>"'()]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(raw)) return;
  for (const a of document.querySelectorAll("[data-support-email]")) {
    a.href = `mailto:${raw}`;
    if (a.hasAttribute("data-show-address")) a.textContent = raw;
  }
  for (const n of document.querySelectorAll("[data-email-only]")) n.hidden = false;
  for (const n of document.querySelectorAll("[data-no-email]")) n.hidden = true;
})();

// Support Yo: "Chip in" (a Stripe Payment Link, SUPPORT_ONCE_LINK) and "Sponsor monthly" (GitHub Sponsors,
// SPONSOR_LINK). Chip in buttons start hidden and appear only for a real https://buy.stripe.com/ or
// https://donate.stripe.com/ link. Sponsor links keep their plain href (it works with JavaScript off) unless
// config.js has a different valid github.com/sponsors/<name> address, and hide when it's empty or invalid.
(() => {
  const url = (raw, hosts, path) => {
    const s = String(raw ?? "").trim();
    if (!s) return null;
    try {
      const u = new URL(s);
      const ok =
        u.protocol === "https:" &&
        hosts.includes(u.hostname) &&
        !u.port &&
        !u.username &&
        !u.password &&
        path.test(u.pathname);
      return ok ? u.href : null;
    } catch {
      return null;
    }
  };
  const once = url(
    window.YO_SITE?.SUPPORT_ONCE_LINK,
    ["buy.stripe.com", "donate.stripe.com"],
    /^\/[A-Za-z0-9_-]+$/,
  );
  for (const a of document.querySelectorAll("[data-support-once]")) {
    if (once) a.href = once;
    a.hidden = !once;
  }
  const sponsor = url(window.YO_SITE?.SPONSOR_LINK, ["github.com"], /^\/sponsors\/[A-Za-z0-9-]+\/?$/);
  for (const a of document.querySelectorAll("[data-sponsor]")) {
    if (sponsor) a.href = sponsor;
    a.hidden = !sponsor;
  }
})();
