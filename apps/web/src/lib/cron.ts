/** Minimal 5-field cron helpers (minute hour dom month dow) for UI previews and the mock backend. */

function parseField(field: string, min: number, max: number): Set<number> | null {
  if (field === "*") return null;
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    let lo = min;
    let hi = max;
    if (range && range !== "*") {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = b !== undefined ? Number(b) : stepStr ? max : lo;
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || !step) return new Set();
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function isValidCron(cron: string): boolean {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return false;
  return f.every((x) => /^[\d*,\-/]+$/.test(x));
}

/** Next fire time after `from` (ms), or null if none within ~2 months. */
export function nextRun(cron: string, from = Date.now()): number | null {
  if (!isValidCron(cron)) return null;
  const [mi, ho, dom, mon, dow] = cron.trim().split(/\s+/) as [string, string, string, string, string];
  const sMi = parseField(mi, 0, 59);
  const sHo = parseField(ho, 0, 23);
  const sDom = parseField(dom, 1, 31);
  const sMon = parseField(mon, 1, 12);
  const sDow = parseField(dow, 0, 6);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 62; i++) {
    const ok =
      (!sMi || sMi.has(d.getMinutes())) &&
      (!sHo || sHo.has(d.getHours())) &&
      (!sDom || sDom.has(d.getDate())) &&
      (!sMon || sMon.has(d.getMonth() + 1)) &&
      (!sDow || sDow.has(d.getDay()) || (sDow.has(7) && d.getDay() === 0));
    if (ok) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

function fmtTime(h: number, m: number): string {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** Human description for common cron shapes; falls back to the raw expression. */
export function describeCron(cron: string | null | undefined): string {
  if (!cron) return "Once";
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [mi, ho, dom, mon, dow] = f as [string, string, string, string, string];
  const everyN = /^\*\/(\d+)$/;
  if (everyN.test(mi) && ho === "*" && dom === "*" && mon === "*" && dow === "*")
    return `Every ${mi.match(everyN)![1]} minutes`;
  if (/^\d+$/.test(mi) && ho === "*" && dom === "*" && mon === "*" && dow === "*")
    return mi === "0" ? "Every hour" : `Every hour at :${mi.padStart(2, "0")}`;
  if (/^\d+$/.test(mi) && everyN.test(ho) && dom === "*" && mon === "*" && dow === "*")
    return `Every ${ho.match(everyN)![1]} hours`;
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && dom === "*" && mon === "*") {
    const t = fmtTime(Number(ho), Number(mi));
    if (dow === "*") return `Every day at ${t}`;
    if (dow === "1-5") return `Weekdays at ${t}`;
    if (dow === "0,6" || dow === "6,0") return `Weekends at ${t}`;
    if (/^\d$/.test(dow)) return `${DAYS[Number(dow) % 7]} at ${t}`;
  }
  if (/^\d+$/.test(mi) && /^\d+$/.test(ho) && /^\d+$/.test(dom) && mon === "*" && dow === "*")
    return `Monthly on day ${dom} at ${fmtTime(Number(ho), Number(mi))}`;
  return cron;
}
