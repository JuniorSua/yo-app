import { useSyncExternalStore } from "react";

/** The theme App.tsx last painted on <html> ("light" or "dark"), so a chat can pick its accent shades. */
function read(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

export function usePaintedTheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, read, () => "light");
}
