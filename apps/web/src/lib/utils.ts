import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function relTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "";
  const diff = now - ts;
  const future = diff < 0;
  const s = Math.abs(diff) / 1000;
  if (s < 45) return future ? "in a moment" : "now";
  const m = s / 60;
  if (m < 60) return future ? `in ${Math.round(m)}m` : `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return future ? `in ${Math.round(h)}h` : `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 7) return future ? `in ${Math.round(d)}d` : `${Math.round(d)}d`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "5m ago", "just now", or a date for older timestamps. */
export function ago(ts: number | null | undefined): string {
  const r = relTime(ts);
  if (r === "now") return "just now";
  return /^\d/.test(r) ? `${r} ago` : r;
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function whenLabel(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const t = clockTime(ts);
  if (d.toDateString() === today.toDateString()) return `Today, ${t}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow, ${t}`;
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${t}`;
}

export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

export function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? "⌘" : "Ctrl";
