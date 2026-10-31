import { create } from "zustand";

/** "Air Glass" in Settings → Appearance (default on). Device-local, like the cached theme. */
export const GLASS_PREF_KEY = "yo.airGlass";

export function readGlassPref(): boolean {
  try {
    return localStorage.getItem(GLASS_PREF_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Off = solid, regular panels (index.html applies the same attribute before first paint). */
export function applyGlassPref(on: boolean) {
  if (on) delete document.documentElement.dataset.glass;
  else document.documentElement.dataset.glass = "off";
}

export const useGlassPref = create<{ on: boolean }>(() => ({ on: readGlassPref() }));

export function setGlassPref(on: boolean) {
  try {
    localStorage.setItem(GLASS_PREF_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  applyGlassPref(on);
  useGlassPref.setState({ on });
}
