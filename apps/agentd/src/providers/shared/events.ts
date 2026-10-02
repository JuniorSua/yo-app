/**
 * Per-session event sink: every normalized event goes through here so that
 * secrets are scrubbed, outputs are truncated and session.state is de-duplicated.
 */
import type { Item, PendingRequest, ProviderEvent, RateLimitInfo } from "@yo/contracts";
import type { EmitFn } from "../ProviderAdapter";
import { redactDeep } from "./env";
import { MAX_IMAGE_CHARS, truncate } from "./util";

type SessionState = "idle" | "running" | "waiting" | "error";

export class EventSink {
  private lastState: SessionState | undefined;

  constructor(
    private readonly emitFn: EmitFn,
    readonly sessionKey: string,
    private readonly secrets: () => string[],
  ) {}

  send(event: ProviderEvent): void {
    this.emitFn(this.sessionKey, redactDeep(event, this.secrets()));
  }

  state(state: SessionState): void {
    if (this.lastState === state) return;
    this.lastState = state;
    this.send({ type: "session.state", state });
  }

  get currentState(): SessionState | undefined {
    return this.lastState;
  }

  private clean(item: Item): Item {
    const out: Item = { ...item };
    if (out.output !== undefined) out.output = truncate(out.output);
    if (out.image !== undefined && out.image.length > MAX_IMAGE_CHARS) delete out.image;
    return out;
  }

  itemStarted(turnId: string | undefined, item: Item): void {
    this.send({ type: "item.started", turnId, item: this.clean(item) });
  }

  itemUpdated(turnId: string | undefined, item: Item): void {
    this.send({ type: "item.updated", turnId, item: this.clean(item) });
  }

  itemCompleted(turnId: string | undefined, item: Item): void {
    this.send({ type: "item.completed", turnId, item: this.clean(item) });
  }

  delta(
    turnId: string | undefined,
    itemId: string,
    stream: "text" | "reasoning" | "command_output",
    delta: string,
  ): void {
    if (!delta) return;
    this.send({ type: "content.delta", turnId, itemId, stream, delta });
  }

  requestOpened(turnId: string | undefined, request: PendingRequest): void {
    this.send({ type: "request.opened", turnId, request });
  }

  rateLimit(info: RateLimitInfo): void {
    this.send({ type: "rate_limit", info });
  }

  error(message: string, fatal = false): void {
    this.send({ type: "runtime.error", message, fatal });
  }

  notice(turnId: string | undefined, id: string, text: string): void {
    this.itemCompleted(turnId, { id, kind: "notice", status: "completed", title: text, text });
  }
}

/** Normalize an epoch that may be seconds or milliseconds into milliseconds. */
export function epochMs(v: number | null | undefined): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
}
