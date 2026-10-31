/** What changed between two versions of a draft, word by word (spaces and line breaks kept with the words). */
export type DiffPart = { text: string; op: "same" | "add" | "del" };

/** Past this many words a side, a word-by-word diff is too slow to run on every render. */
const MAX_TOKENS = 1500;
/** A kept word's weight in the diff: more than all the spaces a draft can have. */
const WORD = MAX_TOKENS + 1;

function tokens(s: string): string[] {
  return s.match(/\s+|[^\s]+/g) ?? [];
}

/** Longest-common-subsequence diff over words. Null when either side is too long to compare. */
export function wordDiff(before: string, after: string): DiffPart[] | null {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;
  // lcs[i][j]: how much of a[i..] and b[j..] can be kept in common. A word outweighs any number of spaces, so
  // a diff never trades a kept word for matched spaces; spaces only decide between otherwise equal diffs.
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + (/^\s/.test(a[i]!) ? 1 : WORD)
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffPart[] = [];
  const push = (text: string, op: DiffPart["op"]) => {
    const last = out[out.length - 1];
    if (last?.op === op) last.text += text;
    else out.push({ text, op });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(a[i]!, "same");
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) push(a[i++]!, "del");
    else push(b[j++]!, "add");
  }
  while (i < a.length) push(a[i++]!, "del");
  while (j < b.length) push(b[j++]!, "add");
  return tidy(out);
}

/**
 * One edit reads as one piece: "~~old words~~ new words", not old and new words interleaved. Changes separated
 * only by a space join into one removal followed by one addition (the space goes to both).
 */
function tidy(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  let del = "";
  let add = "";
  const flush = () => {
    if (del) out.push({ text: del, op: "del" });
    if (add) out.push({ text: add, op: "add" });
    del = "";
    add = "";
  };
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k]!;
    if (p.op === "del") del += p.text;
    else if (p.op === "add") add += p.text;
    else if (/^\s+$/.test(p.text) && (del || add) && parts[k + 1] && parts[k + 1]!.op !== "same") {
      if (del) del += p.text;
      if (add) add += p.text;
      // The next change might only add (or only remove): the space still belongs to the side it joins.
      if (!del && parts[k + 1]!.op === "del") del = p.text;
      if (!add && parts[k + 1]!.op === "add") add = p.text;
    } else {
      flush();
      out.push({ ...p });
    }
  }
  flush();
  // Neighbouring unchanged runs (split around a folded space) read as one.
  return out.reduce<DiffPart[]>((acc, p) => {
    const last = acc[acc.length - 1];
    if (last && last.op === p.op) last.text += p.text;
    else acc.push(p);
    return acc;
  }, []);
}

/**
 * A revision of the same draft, not a different message: most of the words are kept. Below this, showing what
 * changed would just paint the whole draft.
 */
export function isRevision(parts: DiffPart[] | null): parts is DiffPart[] {
  if (!parts) return false;
  let same = 0;
  let changed = 0;
  for (const p of parts) {
    const words = p.text.trim() ? p.text.trim().split(/\s+/).length : 0;
    if (p.op === "same") same += words;
    else changed += words;
  }
  return changed > 0 && same > 0 && same / (same + changed) >= 0.4;
}
