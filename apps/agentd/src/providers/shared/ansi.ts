/**
 * Terminal output cleanup for PTY-driven login flows.
 */

// CSI cursor-forward / column-absolute moves are used by Ink-style TUIs instead of spaces
// ("Welcome\x1b[9Gto"), so they become a single space before the rest of the codes are stripped.
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape parsing
const CURSOR_SPACING = /\x1b\[\d*[CG]/g;
// OSC sequences (hyperlinks, titles): ESC ] ... (BEL | ESC \)
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape parsing
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// CSI sequences: ESC [ params intermediates final
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape parsing
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// Two-char escapes (ESC 7, ESC 8, ESC =, ...)
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape parsing
const ESC2 = /\x1b[@-Z\\-_78=>]/g;

export function stripAnsi(input: string): string {
  return (
    input
      .replace(OSC, "")
      .replace(CURSOR_SPACING, " ")
      .replace(CSI, "")
      .replace(ESC2, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape parsing
      .replace(/\x1b/g, "")
      .replace(/\r(?!\n)/g, "\n")
      .replace(/\r\n/g, "\n")
  );
}
