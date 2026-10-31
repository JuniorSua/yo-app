/** Yo's approval categories (the `yo:` rules), in plain words. */
const CATEGORY_LABELS: Record<string, string> = {
  purchase: "Purchases",
  message: "Sending messages",
  post: "Posting online",
  form: "Submitting forms",
  delete: "Deleting things",
  credentials: "Using saved passwords",
  other: "Other sensitive actions",
};

/** Computer tools people are most likely to save a rule for. */
const TOOL_LABELS: Record<string, string> = {
  browser_navigate: "Opening web pages",
  browser_click: "Clicking on web pages",
  browser_type: "Typing on web pages",
  browser_fill_form: "Filling in web forms",
  browser_select_option: "Choosing options on web pages",
  browser_file_upload: "Uploading files",
  browser_evaluate: "Running scripts on web pages",
  bash: "Running commands",
  Bash: "Running commands",
  write: "Saving files",
  Write: "Saving files",
  edit: "Editing files",
  Edit: "Editing files",
};

/**
 * A saved rule's `match` as a person would say it: "yo:purchase" → "Purchases",
 * "mcp__playwright__browser_navigate" → "Opening web pages", "yo:1password:github.com" → "1Password sign-ins on
 * github.com", anything else → its name without prefixes or
 * underscores ("mcp__gmail__send_draft" → "Send draft").
 */
export function ruleLabel(match: string): string {
  const name = match.replace(/^yo:/, "").replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
  // "Always allow" on a 1Password card is for one site: "yo:1password:github.com".
  const site = /^1password:(.+)$/.exec(name);
  if (site) return `1Password sign-ins on ${site[1]}`;
  if (CATEGORY_LABELS[name]) return CATEGORY_LABELS[name];
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  const words = name.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : match;
}

const CHIP_KEYS: Record<string, string> = {
  total: "Total",
  amount: "Amount",
  recipient: "To",
  url: "Link",
  site: "Site",
  login: "1Password login",
};

/** An approval's detail chip: "Category purchase" → "Purchase", "recipient ana@x" → "To ana@x". */
export function chipText(key: string, value: string): { label?: string; value: string } {
  if (key === "category") return { value: value[0] ? value[0].toUpperCase() + value.slice(1) : value };
  return { label: CHIP_KEYS[key] ?? key, value };
}
