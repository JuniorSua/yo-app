// Light, safe markdown for Yo's replies, close to what the desktop app shows.
// Blocks: paragraphs (lines joined with <br>), # headings (h3/h4), > quotes, --- rules, lists (one nested
// level, [ ] task items), ``` code (language kept as data-lang) and GFM pipe tables.
// Inline: **bold**, *italics*, ~~strike~~, `code`, [links](https://…), <https://…>, bare URLs, ![pictures](src).
// Safety: every piece of input text is HTML-escaped; only the tags made here are emitted (no inline styles);
// links must be http(s), mailto: or tel:. The one exception is the optional `image` callback, whose
// returned HTML is inserted as-is, so the caller must make it safe.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

const HOLD = "\u0000";
const HOLD_ALL = new RegExp(HOLD, "g");
const heldRe = () => new RegExp(`${HOLD}(\\d+)${HOLD}`, "g");

// ![alt](src "title") or ![alt](<src with spaces>). Groups: 1 alt, 2 <src>, 3 src.
const IMAGE_SRC = '!\\[([^\\]\\n]*)\\]\\(\\s*(?:<([^<>\\n]+)>|([^\\s()<>]+))(?:\\s+"[^"\\n]*")?\\s*\\)';
const IMAGE = new RegExp(IMAGE_SRC, "g");
const LONE_IMAGE = new RegExp(`^\\s*${IMAGE_SRC}\\s*$`);
const HREF = "(?:https?:\\/\\/|mailto:|tel:)";
// [label](href "title") or [label](<href>). Groups: 1 label, 2 <href>, 3 href.
const LINK = new RegExp(
  `\\[([^\\]\\n]+)\\]\\(\\s*(?:<(${HREF}[^<>\\s]+)>|(${HREF}(?:[^\\s()<>]|\\([^\\s()<>]*\\))+))(?:\\s+"[^"\\n]*")?\\s*\\)`,
  "gi",
);
const AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>"]+)>/gi;
const BARE_URL = new RegExp(`\\bhttps?:\\/\\/[^\\s<>()"${HOLD}]+[^\\s<>().,;:!?'"${HOLD}]`, "g");

function anchor(href, labelHtml, cls = "") {
  const web = /^https?:/i.test(href);
  const attrs = `${cls ? ` class="${cls}"` : ""}${web ? ' target="_blank" rel="noopener noreferrer"' : ""}`;
  return `<a href="${escapeHtml(href)}"${attrs}>${labelHtml}</a>`;
}

function fileName(src) {
  const name =
    String(src)
      .replace(/[?#].*$/, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() || "";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function customImage(opts, src, alt) {
  if (typeof opts?.image !== "function") return null;
  try {
    const html = opts.image(src, alt);
    return typeof html === "string" ? html : null;
  } catch {
    return null;
  }
}

function defaultImage(src, alt) {
  if (/^https?:\/\//i.test(src)) return anchor(src, `🖼 ${escapeHtml(alt || "Picture")}`, "img-link");
  return `<span class="img-missing">Picture: ${escapeHtml(alt || fileName(src) || "picture")}</span>`;
}

function inline(raw, opts) {
  const held = [];
  const raws = [];
  const hold = (html, text = "") => {
    raws.push(text);
    return `${HOLD}${held.push(html) - 1}${HOLD}`;
  };
  const plain = (s) => s.replace(heldRe(), (_, i) => raws[Number(i)] ?? "");
  let s = String(raw).replace(HOLD_ALL, "");

  s = s.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`, code));
  s = s.replace(IMAGE, (_, alt, angled, bare) => {
    const src = (angled ?? bare).trim();
    const text = plain(alt);
    return hold(customImage(opts, src, text) ?? defaultImage(src, text), text);
  });
  s = s.replace(LINK, (_, label, angled, bare) => hold(anchor(angled ?? bare, inlineText(label))));
  s = s.replace(AUTOLINK, (_, href) => hold(anchor(href, escapeHtml(href))));
  s = s.replace(BARE_URL, (href) => hold(anchor(href, escapeHtml(href))));
  s = inlineText(s);
  // Held pieces can hold others (code inside a link label), so expand a few rounds, then drop leftovers.
  for (let n = 0; n < 4 && s.includes(HOLD); n++) s = s.replace(heldRe(), (_, i) => held[Number(i)] ?? "");
  return s.replace(heldRe(), "").replace(HOLD_ALL, "");
}

function inlineText(s) {
  return escapeHtml(s)
    .replace(/\*\*(?=\S)([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([^_]+?)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=\S)([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([^~]+?)~~/g, "<s>$1</s>");
}

const LIST_ITEM = /^([ \t]*)(?:[-*•]|(\d{1,9})[.)])[ \t]+(.*)$/;
const TASK = /^\[([ xX])\](?:[ \t]+(.*))?$/;
const HEADING = /^\s*(#{1,6})[ \t]+(.*)$/;
const QUOTE = /^\s*>[ \t]?(.*)$/;
const HR = /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^\s*```/;
const FENCE_LANG = /^\s*```[ \t]*([^\s`]*)/;
const LANG_OK = /^[\w+#.-]{1,20}$/;

const indentOf = (s) => s.replace(/\t/g, "    ").length;

/** Splits a table row into trimmed cells; outer pipes optional, `\|` is a literal pipe. */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [""];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cells[cells.length - 1] += "|";
      i++;
    } else if (s[i] === "|") cells.push("");
    else cells[cells.length - 1] += s[i];
  }
  return cells.map((c) => c.trim());
}

function isSeparator(line) {
  if (!/^[\s|:-]+$/.test(line) || !line.includes("-")) return false;
  return splitRow(line).every((c) => /^:?-+:?$/.test(c));
}

function tableHtml(header, sep, rows, opts) {
  const align = splitRow(sep).map((c) => {
    if (c.startsWith(":") && c.endsWith(":")) return ' class="al-c"';
    return c.endsWith(":") ? ' class="al-r"' : "";
  });
  const cols = align.length;
  const cells = (line, tag) => {
    const got = splitRow(line);
    let html = "";
    for (let c = 0; c < cols; c++) html += `<${tag}${align[c]}>${inline(got[c] ?? "", opts)}</${tag}>`;
    return `<tr>${html}</tr>`;
  };
  return `<div class="table-wrap"><table><thead>${cells(header, "th")}</thead><tbody>${rows
    .map((r) => cells(r, "td"))
    .join("")}</tbody></table></div>`;
}

function listHtml(list, opts) {
  const start = list.tag === "ol" && list.start !== 1 ? ` start="${list.start}"` : "";
  const items = list.items.map((item) => {
    const subs = item.subs.map((sub) => listHtml(sub, opts)).join("");
    const task = TASK.exec(item.text);
    if (!task) return `<li>${inline(item.text, opts)}${subs}</li>`;
    const done = task[1] !== " ";
    const mod = done ? " done" : "";
    return `<li class="task${mod}"><span class="check${mod}" aria-hidden="true">${done ? "☑" : "☐"}</span> ${inline(task[2] ?? "", opts)}${subs}</li>`;
  });
  return `<${list.tag}${start}>${items.join("")}</${list.tag}>`;
}

function render(lines, opts, depth) {
  const out = [];
  let para = [];
  let list = null; // { tag, start, base, items: [{ text, subs: [{ tag, start, items }] }] }

  const flushPara = () => {
    let run = [];
    const flushRun = () => {
      if (run.length) out.push(`<p>${run.join("<br>")}</p>`);
      run = [];
    };
    for (const line of para) {
      const lone = line.includes("`") ? null : LONE_IMAGE.exec(line.replace(HOLD_ALL, ""));
      if (!lone) {
        run.push(inline(line, opts));
        continue;
      }
      const src = (lone[2] ?? lone[3]).trim();
      const custom = customImage(opts, src, lone[1]);
      if (custom === null) run.push(defaultImage(src, lone[1]));
      else {
        flushRun();
        out.push(custom); // a picture alone on its line is its own block
      }
    }
    flushRun();
    para = [];
  };
  const flushList = () => {
    if (list) out.push(listHtml(list, opts));
    list = null;
  };
  const flush = () => {
    flushPara();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flush();
      const lang = FENCE_LANG.exec(line)[1];
      const attr = LANG_OK.test(lang) ? ` data-lang="${escapeHtml(lang)}"` : "";
      const code = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
      out.push(`<pre><code${attr}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const next = lines[i + 1];
    if (
      line.includes("|") &&
      next !== undefined &&
      isSeparator(next) &&
      splitRow(line).length === splitRow(next).length
    ) {
      flush();
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|") && !FENCE.test(lines[i])) {
        rows.push(lines[i++]);
      }
      i--;
      out.push(tableHtml(line, next, rows, opts));
      continue;
    }
    if (HR.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flushPara();
      const tag = item[2] === undefined ? "ul" : "ol";
      const start = tag === "ol" ? Number(item[2]) : 1;
      const indent = indentOf(item[1]);
      const entry = { text: item[3], subs: [] };
      if (list && indent >= list.base + 2) {
        const parent = list.items[list.items.length - 1];
        let sub = parent.subs[parent.subs.length - 1];
        if (!sub || sub.tag !== tag) {
          sub = { tag, start, items: [] };
          parent.subs.push(sub);
        }
        sub.items.push(entry);
      } else {
        if (!list || list.tag !== tag) {
          flushList();
          list = { tag, start, base: indent, items: [] };
        }
        list.items.push(entry);
      }
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      const last = list.items[list.items.length - 1];
      const sub = last.subs[last.subs.length - 1];
      const target = sub ? sub.items[sub.items.length - 1] : last;
      target.text += ` ${line.trim()}`;
      continue;
    }
    flushList();
    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      const tag = heading[1].length <= 2 ? "h3" : "h4";
      const title = heading[2].trim().replace(/\s+#+$/, "");
      out.push(`<${tag}>${inline(title, opts)}</${tag}>`);
      continue;
    }
    if (depth < 4 && QUOTE.test(line)) {
      flushPara();
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])[1]);
      i--;
      out.push(`<blockquote>${render(inner, opts, depth + 1)}</blockquote>`);
      continue;
    }
    para.push(line);
  }
  flush();
  return out.join("");
}

const toLines = (text) =>
  String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");

/**
 * Yo's reply as safe HTML.
 * @param {string} text
 * @param {{ image?: (src: string, alt: string) => string | null }} [opts]
 *   `image` is called for each picture with its raw (unescaped) src and alt. A returned string is inserted
 *   verbatim, so it must already be safe HTML; null (or no callback) gives a link for http(s) pictures and
 *   a "Picture: name" label for anything else. A picture alone on its line is emitted without a <p> wrapper.
 */
export function renderMarkdown(text, opts = {}) {
  return render(toLines(text), opts, 0);
}

/**
 * Pictures referenced in the text, in order and once per src. Skips code blocks and inline code.
 * @param {string} text
 * @returns {Array<{ src: string, alt: string }>}
 */
export function imageSources(text) {
  const seen = new Set();
  const found = [];
  let inFence = false;
  for (const line of toLines(text)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.replace(/`[^`\n]+`/g, " ").matchAll(IMAGE)) {
      const src = (m[2] ?? m[3]).trim();
      if (seen.has(src)) continue;
      seen.add(src);
      found.push({ src, alt: m[1] });
    }
  }
  return found;
}

/** Plain text for reading aloud: no markup, links read as their label, pictures as their alt text. */
export function toSpeech(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/```[\s\S]*?(?:```|$)/g, " (code) ")
    .replace(/^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "")
    .split("\n")
    .map((line) => {
      if (!line.includes("|")) return line;
      if (isSeparator(line)) return "";
      return `${splitRow(line).filter(Boolean).join(", ")}.`;
    })
    .join("\n")
    .replace(/!\[([^\]\n]*)\]\((?:<[^>\n]*>|[^)\n]*)\)/g, (_, alt) => alt.trim() || "a picture")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<(?:https?:\/\/|mailto:)[^\s>]+>/gi, "a link")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s*>[>\s]*/gm, "")
    .replace(/^\s*[-*•]\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/[*_~`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
