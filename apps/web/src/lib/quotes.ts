/** A message the user typed, split into quoted lines ("> …", like Markdown) and the rest. */
export type TextBlock = { quote: boolean; text: string };

const QUOTE = /^ {0,3}> ?/;

export function quoteBlocks(text: string): TextBlock[] {
  const out: TextBlock[] = [];
  for (const line of text.split("\n")) {
    const quote = QUOTE.test(line);
    const body = quote ? line.replace(QUOTE, "") : line;
    const last = out[out.length - 1];
    if (last && last.quote === quote) last.text += `\n${body}`;
    else out.push({ quote, text: body });
  }
  return out;
}
