import { useEffect, useState } from "react";

/** The current time, refreshed every `everyMs` while `active` (timers that count up on screen). */
export function useNow(everyMs = 1000, active = true): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs, active]);
  return now;
}
