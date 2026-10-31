import { type ComponentType, lazy, useState } from "react";

const preloads: (() => Promise<unknown>)[] = [];

/**
 * A component whose code isn't part of the startup bundle (Settings, the workspace pages, the computer window,
 * first-run setup). The app starts with less JavaScript to download and run, and `preloadWhenIdle()` fetches
 * these right after, so opening one is still instant. Render it inside a `<Suspense>`.
 */
export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  let loaded: ComponentType<P> | undefined;
  let loading: Promise<ComponentType<P>> | undefined;
  const preload = () =>
    (loading ??= load().then(
      (c) => (loaded = c),
      (e) => {
        loading = undefined;
        throw e;
      },
    ));
  preloads.push(preload);
  const Lazy = lazy(() => preload().then((c) => ({ default: c }), reloadForNewVersion));
  return function LazyComponent(props: P) {
    // Once loaded, render it directly (no Suspense frame). Chosen once per mount so it never remounts.
    const [C] = useState<ComponentType<P>>(() => loaded ?? Lazy);
    return <C {...props} />;
  };
}

/**
 * A missing chunk almost always means Yo's web app was updated on the server and the old file names are gone.
 * Reload to pick up the new version instead of crashing (at most once a minute, so a real outage still shows).
 */
function reloadForNewVersion(e: unknown): Promise<never> {
  try {
    const last = Number(sessionStorage.getItem("yo.chunkReload") ?? 0);
    if (Date.now() - last > 60_000) {
      sessionStorage.setItem("yo.chunkReload", String(Date.now()));
      location.reload();
      return new Promise<never>(() => {});
    }
  } catch {
    /* no sessionStorage: fall through */
  }
  return Promise.reject(e);
}

/** Load every lazy component in the background, one at a time, while the app is idle. */
export function preloadWhenIdle() {
  const queue = [...preloads];
  const idle = (fn: () => void) =>
    typeof requestIdleCallback === "function"
      ? requestIdleCallback(fn, { timeout: 2000 })
      : setTimeout(fn, 200);
  const next = () => {
    const load = queue.shift();
    if (load) idle(() => void load().then(next, next));
  };
  next();
}
