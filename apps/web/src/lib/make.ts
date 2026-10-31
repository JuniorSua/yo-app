import type { Artifact, PageKind } from "@yo/contracts";

/**
 * The Make page: everything Yo made, by kind. Pages (create_page) carry their own kind (a dashboard, slides, a
 * doc…); saved files and bug reports are kinds of their own.
 */
export type MakeKind = PageKind | "file" | "bug";
export type MakeFilter = "all" | MakeKind;

/** The order of the filter chips (and of kinds anywhere they're listed). */
export const MAKE_KIND_ORDER: readonly MakeKind[] = [
  "page",
  "dashboard",
  "slides",
  "doc",
  "design",
  "file",
  "bug",
];

/** One of them, in a word: "Dashboard · 5m ago". */
export const KIND_LABEL: Record<MakeKind, string> = {
  page: "Page",
  dashboard: "Dashboard",
  slides: "Slides",
  doc: "Doc",
  design: "Design",
  file: "File",
  bug: "Bug report",
};

/** The chips: "Dashboards". */
export const KIND_PLURAL: Record<MakeKind, string> = {
  page: "Pages",
  dashboard: "Dashboards",
  slides: "Slides",
  doc: "Docs",
  design: "Designs",
  file: "Files",
  bug: "Bug reports",
};

/** Each kind's colour (styles.css `--kind-*`, AA in light and dark). Tiles mix 13% of it into the card. */
export const KIND_COLOUR: Record<MakeKind, string> = {
  page: "var(--kind-red)",
  slides: "var(--kind-amber)",
  dashboard: "var(--kind-violet)",
  design: "var(--kind-violet)",
  doc: "var(--kind-blue)",
  file: "var(--kind-grey)",
  bug: "var(--kind-red)",
};

export function kindTint(kind: MakeKind, pct = 13): string {
  return `color-mix(in srgb, ${KIND_COLOUR[kind]} ${pct}%, var(--card))`;
}

export function makeKindOf(a: Pick<Artifact, "kind" | "pageKind">): MakeKind {
  if (a.kind === "bug") return "bug";
  if (a.kind === "page") return a.pageKind ?? "page";
  return "file";
}

/** "All", then a chip for each kind there's something of, in the usual order. */
export function makeFilters(
  list: readonly Pick<Artifact, "kind" | "pageKind">[],
): { id: MakeFilter; label: string }[] {
  const present = new Set(list.map(makeKindOf));
  return [
    { id: "all", label: "All" },
    ...MAKE_KIND_ORDER.filter((k) => present.has(k)).map((k) => ({ id: k, label: KIND_PLURAL[k] })),
  ];
}

export function filterMade<T extends Pick<Artifact, "kind" | "pageKind">>(
  list: readonly T[],
  filter: MakeFilter,
): T[] {
  return filter === "all" ? [...list] : list.filter((a) => makeKindOf(a) === filter);
}

/** What the + offers, nearest the + last, each with the line the message box opens with. */
export const MAKE_STARTERS: readonly { id: PageKind; label: string; starter: string }[] = [
  { id: "dashboard", label: "Dashboard", starter: "Make a dashboard of …" },
  { id: "slides", label: "Slides", starter: "Make a deck about …" },
  { id: "doc", label: "Doc", starter: "Write a doc about …" },
  { id: "page", label: "Web page", starter: "Make a web page about …" },
  { id: "design", label: "Design", starter: "Make a design for …" },
];

/** The starter as a draft to finish: "Make a deck about " (the "…" is where the user's words go). */
export function starterDraft(starter: string): string {
  return starter.replace(/\s*…\s*$/, " ");
}
