import type { ApiPushChannel, ApiPushes, TimelineEntry } from "@yo/contracts";
import { forUi } from "./timelineView";

/** `frame()` is the push serialized for the wire, built once per push however many sockets listen. */
type Listener = (channel: ApiPushChannel, data: unknown, frame: () => string) => void;

/** Fan-out of server pushes to connected UI sockets. */
export class Hub {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  push<K extends ApiPushChannel>(channel: K, data: ApiPushes[K]) {
    if (channel === "timeline.upsert") data = forUi(data as TimelineEntry) as ApiPushes[K];
    let json: string | null = null;
    const frame = () => {
      json ??= JSON.stringify({ push: channel, data });
      return json;
    };
    for (const l of this.listeners) {
      try {
        l(channel, data, frame);
      } catch {
        /* ignore broken listener */
      }
    }
  }

  get clientCount() {
    return this.listeners.size;
  }
}
