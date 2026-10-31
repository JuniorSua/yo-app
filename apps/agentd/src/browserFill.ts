/**
 * 1Password sign-ins (`browser.fillLogin`): type a login core resolved into the sign-in page open in the agent's
 * browser, then submit it. The agent's model never sees the values: core sends them here, this types them over
 * CDP (like a password manager's autofill), and only "which fields were filled" goes back.
 *
 * Safety:
 * - Only into a tab whose address matches the login's websites (pageMatchesAny), checked again in the page right
 *   before each field is typed, so a redirect in between can't catch it.
 * - Only into the top frame, through an isolated world (the page's own scripts can't hook our lookups).
 * - Values are never logged, and errors never include them.
 * - After submitting, a password or code still in the form is cleared: Playwright's page snapshots include input
 *   values, so a failed sign-in would otherwise show the password to the model on its next snapshot.
 *
 * On the shared computer the agent's CDP port is its seat's proxy (cdpProxy.ts), so only its own tabs are seen.
 */
import {
  type FillLoginResult,
  type LoginSite,
  type OnePasswordFieldKind,
  pageMatchesAny,
  siteHost,
} from "@yo/contracts";
import { CdpClient, type CdpTarget } from "./displays/cdpClient";

export interface FillLoginRequest {
  sites: LoginSite[];
  fields: { kind: OnePasswordFieldKind; value?: string }[];
  dryRun: boolean;
}

/** Fill order on a page: who you are, then the secret, then the code. */
const ORDER: OnePasswordFieldKind[] = ["username", "password", "one_time_code"];
/** How long to watch the page after submitting before checking for a leftover secret. */
const SETTLE_MS = 3000;
const POLL_MS = 250;

/** An error whose message is safe to show the model (it never contains a value). */
export class FillError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * What leaves fillLogin. A FillError was written without the typed value. Any other error (CDP, the page)
 * can quote what was just typed, so its text is dropped before logs or the model can see it.
 */
export function safeFillError(err: unknown): FillError {
  if (err instanceof FillError) return err;
  return new FillError("Couldn't type into the page. Try again.", "fill_failed");
}

/**
 * Runs in the page's isolated world. Finds the sign-in fields (also inside open shadow roots), keeps them on
 * `globalThis.__yo1p` for the next calls, and reports only which kinds it found and the page address.
 * Plain JavaScript in a string: it must not depend on how agentd is bundled.
 */
export const PAGE_SCRIPT = String.raw`(() => {
  if (globalThis.__yo1pApi) return true;
  const USER = /user|e-?mail|login|account|identifier|phone|member|customer/i;
  const OTP = /one.?time|otp|totp|2fa|two.?factor|mfa|verif|security.?code|auth.*code|passcode|\bcode\b|token|pin/i;
  const SEARCH = /search|query|\bq\b/i;
  const all = () => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.tagName === "INPUT") out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  };
  const visible = (el) => {
    if (el.disabled || el.readOnly || el.type === "hidden") return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const words = (el) =>
    [el.name, el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"),
      ...[...(el.labels || [])].map((l) => l.textContent)].filter(Boolean).join(" ");
  const ac = (el) => (el.getAttribute("autocomplete") || "").toLowerCase();
  const texty = (el) => ["", "text", "email", "tel", "number"].includes(el.type);
  const find = () => {
    const inputs = all().filter(visible);
    const pw = inputs.filter((el) => el.type === "password");
    const password = pw.find((el) => ac(el).includes("current-password")) ||
      pw.find((el) => !ac(el).includes("new-password")) || null;
    // A code: autocomplete="one-time-code", or a short field named like one; or a row of 4–8 one-letter boxes.
    let otp = inputs.filter((el) => el !== password && (ac(el).includes("one-time-code") ||
      ((texty(el) || el.type === "password") && OTP.test(words(el)) && !USER.test(words(el)))));
    const boxes = inputs.filter((el) => texty(el) && el.maxLength === 1);
    const row = boxes.length >= 4 && boxes.length <= 8 && boxes.every((b) => b.parentElement?.parentElement ===
      boxes[0].parentElement?.parentElement || b.parentElement === boxes[0].parentElement) ? boxes : null;
    if (row) otp = row;
    else otp = otp.slice(0, 1);
    const taken = new Set([password, ...otp]);
    const candidates = inputs.filter((el) => !taken.has(el) && texty(el) && el.type !== "number" &&
      !SEARCH.test(words(el)) && el.getAttribute("role") !== "searchbox");
    let username = candidates.find((el) => /username|email/.test(ac(el))) ||
      candidates.find((el) => USER.test(words(el))) || null;
    if (!username && password) {
      // The text field right before the password field, in the same form.
      const before = candidates.filter((el) => el.form === password.form &&
        (el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING));
      username = before[before.length - 1] || null;
    }
    if (!password && otp.length && !row && username === otp[0]) username = null;
    return { username, password, one_time_code: otp.length ? otp : null };
  };
  const setValue = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  let found = { username: null, password: null, one_time_code: null };
  globalThis.__yo1pApi = {
    probe() {
      found = find();
      return { url: location.href, top: window.top === window,
        kinds: Object.keys(found).filter((k) => found[k]), boxes: found.one_time_code ? found.one_time_code.length : 0 };
    },
    focus(kind, i) {
      const f = found[kind];
      const el = Array.isArray(f) ? f[i || 0] : f;
      if (!el || !el.isConnected) return { url: location.href, ok: false };
      el.scrollIntoView({ block: "center", inline: "nearest" });
      el.focus();
      if (typeof el.select === "function") el.select();
      return { url: location.href, ok: document.activeElement === el ||
        (el.getRootNode() !== document && el.getRootNode().activeElement === el) };
    },
    length(kind, i) {
      const f = found[kind];
      const el = Array.isArray(f) ? f[i || 0] : f;
      return el && el.isConnected ? el.value.length : -1;
    },
    set(kind, i, v) {
      const f = found[kind];
      const el = Array.isArray(f) ? f[i || 0] : f;
      if (!el || !el.isConnected) return false;
      setValue(el, v);
      return el.value.length === v.length;
    },
    submit(kind) {
      const f = found[kind];
      const el = Array.isArray(f) ? f[f.length - 1] : f;
      if (!el || !el.isConnected) return "gone";
      const scope = el.form || el.closest("form, [role=form], [role=dialog], main") || document;
      const buttons = [...scope.querySelectorAll("button, input[type=submit], input[type=image], [role=button]")]
        .filter(visible);
      const isSubmit = (b) => b.type === "submit" || b.type === "image" ||
        /sign.?in|log.?in|continue|next|submit|verify|confirm/i.test(b.textContent || b.value || b.getAttribute("aria-label") || "");
      const button = buttons.find((b) => !b.disabled && b.type === "submit") || buttons.find((b) => !b.disabled && isSubmit(b));
      if (button) { button.click(); return "clicked"; }
      return "enter";
    },
    leftover() {
      let cleared = false;
      for (const kind of ["password", "one_time_code"]) {
        const f = found[kind];
        for (const el of Array.isArray(f) ? f : f ? [f] : []) {
          if (el.isConnected && el.value) { setValue(el, ""); cleared = true; }
        }
      }
      return cleared;
    },
  };
  return true;
})()`;

interface Probe {
  url: string;
  top: boolean;
  kinds: OnePasswordFieldKind[];
  boxes: number;
}

/** One attached tab with the page script installed in an isolated world. */
class PageSession {
  private constructor(
    private readonly cdp: CdpClient,
    readonly target: CdpTarget,
    private readonly sessionId: string,
    private contextId: number,
  ) {}

  static async open(cdp: CdpClient, target: CdpTarget): Promise<PageSession> {
    const { sessionId } = await cdp.call<{ sessionId: string }>("Target.attachToTarget", {
      targetId: target.id,
      flatten: true,
    });
    const s = new PageSession(cdp, target, sessionId, 0);
    await s.install();
    return s;
  }

  /** (Re)create the isolated world on the current document and load the page script into it. */
  async install(): Promise<void> {
    const tree = await this.cdp.call<{ frameTree: { frame: { id: string } } }>(
      "Page.getFrameTree",
      {},
      10_000,
      this.sessionId,
    );
    const { executionContextId } = await this.cdp.call<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      { frameId: tree.frameTree.frame.id, worldName: "yo-1password", grantUniveralAccess: false },
      10_000,
      this.sessionId,
    );
    this.contextId = executionContextId;
    await this.eval(PAGE_SCRIPT);
  }

  async eval<T>(expression: string): Promise<T> {
    const r = await this.cdp.call<{ result: { value?: T }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, contextId: this.contextId, returnByValue: true, awaitPromise: false },
      10_000,
      this.sessionId,
    );
    // The page's error text could quote the page, never a value (values never go into an expression).
    if (r.exceptionDetails) throw new FillError("The sign-in page didn't respond as expected.", "page_error");
    return r.result.value as T;
  }

  /** Call a page-script method with arguments passed as CDP values (never spliced into source). */
  async callApi<T>(method: string, args: unknown[]): Promise<T> {
    const { result } = await this.cdp.call<{ result: { objectId?: string } }>(
      "Runtime.evaluate",
      { expression: "globalThis.__yo1pApi", contextId: this.contextId },
      10_000,
      this.sessionId,
    );
    if (!result.objectId) throw new FillError("The sign-in page changed while filling.", "page_changed");
    const r = await this.cdp.call<{ result: { value?: T }; exceptionDetails?: unknown }>(
      "Runtime.callFunctionOn",
      {
        objectId: result.objectId,
        functionDeclaration: `function (...a) { return this[${JSON.stringify(method)}](...a); }`,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
      },
      10_000,
      this.sessionId,
    );
    if (r.exceptionDetails) throw new FillError("The sign-in page didn't respond as expected.", "page_error");
    return r.result.value as T;
  }

  insertText(text: string): Promise<unknown> {
    return this.cdp.call("Input.insertText", { text }, 10_000, this.sessionId);
  }

  async pressEnter(): Promise<void> {
    for (const type of ["keyDown", "keyUp"] as const)
      await this.cdp.call(
        "Input.dispatchKeyEvent",
        {
          type,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          ...(type === "keyDown" ? { text: "\r" } : {}),
        },
        10_000,
        this.sessionId,
      );
  }

  async currentUrl(): Promise<string | null> {
    const r = await this.cdp
      .call<{ result: { value?: string } }>(
        "Runtime.evaluate",
        { expression: "location.href", returnByValue: true },
        5000,
        this.sessionId,
      )
      .catch(() => null);
    return r?.result.value ?? null;
  }

  async detach(): Promise<void> {
    await this.cdp.call("Target.detachFromTarget", { sessionId: this.sessionId }, 5000).catch(() => {});
  }
}

/** The hosts a login is saved for, for messages ("github.com or gitlab.com"). */
export function hostsOf(sites: LoginSite[]): string {
  const hosts = [...new Set(sites.filter((s) => s.mode !== "never").map((s) => siteHost(s.url)))].filter(
    Boolean,
  ) as string[];
  return hosts.length ? hosts.slice(0, 3).join(" or ") : "no website";
}

/** Tabs that may get the login, best first (in the order Chromium lists them). */
export function matchingTabs(pages: CdpTarget[], sites: LoginSite[]): CdpTarget[] {
  return pages.filter((p) => p.type === "page" && pageMatchesAny(p.url, sites));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `browser.fillLogin` on the agent's browser at `port` (its own Chromium, or its seat's CDP proxy). */
export async function fillLogin(port: number, req: FillLoginRequest): Promise<FillLoginResult> {
  try {
    return await fillLoginUnsafe(port, req);
  } catch (err) {
    throw safeFillError(err);
  }
}

async function fillLoginUnsafe(port: number, req: FillLoginRequest): Promise<FillLoginResult> {
  if (!req.sites.some((s) => s.mode !== "never"))
    throw new FillError("This 1Password login has no website Yo may fill it on.", "no_site");
  const cdp = await CdpClient.connect(port).catch(() => {
    throw new FillError("Couldn't reach your browser. Open the sign-in page and try again.", "no_browser");
  });
  const opened: PageSession[] = [];
  try {
    const tabs = matchingTabs(await cdp.pages(), req.sites);
    if (!tabs.length)
      throw new FillError(
        `No open tab is on ${hostsOf(req.sites)}. Open the sign-in page in your browser first.`,
        "no_tab",
      );
    const wanted = req.fields.map((f) => f.kind);
    // The first matching tab that shows one of the wanted fields.
    let page: PageSession | null = null;
    let probe: Probe | null = null;
    for (const tab of tabs.slice(0, 5)) {
      const s = await PageSession.open(cdp, tab).catch(() => null);
      if (!s) continue;
      opened.push(s);
      const p = await s.callApi<Probe>("probe", []).catch(() => null);
      if (!p?.top || !pageMatchesAny(p.url, req.sites)) continue;
      if (!page) {
        page = s;
        probe = p;
      }
      if (p.kinds.some((k) => wanted.includes(k))) {
        page = s;
        probe = p;
        break;
      }
    }
    if (!page || !probe)
      throw new FillError(`Couldn't read the sign-in page on ${hostsOf(req.sites)}.`, "page_error");
    const host = new URL(probe.url).hostname;
    const found = ORDER.filter((k) => wanted.includes(k) && probe.kinds.includes(k));
    if (req.dryRun) return { host, found, filled: [], submitted: false, stillOnForm: false };
    if (!found.length)
      throw new FillError(
        `The page on ${host} doesn't show a ${wanted.map((k) => k.replace(/_/g, "-")).join(" or ")} field Yo can recognize.`,
        "no_field",
      );

    const filled: OnePasswordFieldKind[] = [];
    for (const kind of found) {
      const value = req.fields.find((f) => f.kind === kind)?.value;
      if (!value) continue;
      if (kind === "one_time_code" && probe.boxes > 1) {
        // One box per character.
        if (probe.boxes !== value.length)
          throw new FillError(`The code boxes on ${host} don't fit this login's code.`, "no_field");
        for (let i = 0; i < value.length; i++) await typeInto(page, req.sites, kind, i, value[i]!);
      } else {
        await typeInto(page, req.sites, kind, 0, value);
      }
      filled.push(kind);
    }
    if (!filled.length)
      throw new FillError("This login has none of the fields the page asks for.", "no_value");

    // Submit from the last field typed: its form's submit button, else Enter.
    const how = await page.callApi<string>("submit", [filled[filled.length - 1]]).catch(() => "gone");
    if (how === "enter") await page.pressEnter();
    const submitted = how !== "gone";
    const stillOnForm = filled.some((k) => k !== "username") ? await settleAndClear(page, probe.url) : false;
    return { host, found, filled, submitted, stillOnForm };
  } finally {
    for (const s of opened) await s.detach();
    cdp.close();
  }
}

/** Focus one field, check the page is still the right site, and type. */
async function typeInto(
  page: PageSession,
  sites: LoginSite[],
  kind: OnePasswordFieldKind,
  index: number,
  value: string,
): Promise<void> {
  const f = await page.callApi<{ url: string; ok: boolean }>("focus", [kind, index]);
  if (!pageMatchesAny(f.url, sites))
    throw new FillError(
      "The page moved to another site before Yo could fill it. Nothing was typed.",
      "moved",
    );
  if (!f.ok) throw new FillError("Couldn't put the cursor in the sign-in field.", "no_focus");
  await page.insertText(value);
  // Some fields (masks, custom widgets) drop typed text: fall back to setting the value.
  const len = await page.callApi<number>("length", [kind, index]);
  if (len !== value.length) {
    const again = await page.callApi<{ url: string }>("focus", [kind, index]);
    if (!pageMatchesAny(again.url, sites))
      throw new FillError("The page moved to another site while filling.", "moved");
    if (!(await page.callApi<boolean>("set", [kind, index, value])))
      throw new FillError("The sign-in field didn't take the value.", "not_taken");
  }
}

/**
 * After submitting: wait for the page to move on. If it's still on the same document after a few seconds and a
 * password or code is still in the form, clear it. Returns true when the sign-in form is still showing.
 */
async function settleAndClear(page: PageSession, before: string): Promise<boolean> {
  const until = Date.now() + SETTLE_MS;
  while (Date.now() < until) {
    await sleep(POLL_MS);
    const url = await page.currentUrl();
    if (url === null || url !== before) break;
  }
  // Same document: the isolated world still holds the fields. A new document: the old fields are gone.
  return page.callApi<boolean>("leftover", []).catch(() => false);
}
