import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

export const MD_PLUGINS = [remarkGfm];

/**
 * How every chat bubble renders Markdown: links open outside, fenced blocks get the Copy card, and a table too
 * wide for the chat scrolls on its own instead of being cut off.
 */
export const CHAT_MD: Components = {
  a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
  pre: ({ node: _n, ...p }) => <CodeBlock {...p} />,
  table: ({ node: _n, ...p }) => (
    <div className="table-wrap">
      <table {...p} />
    </div>
  ),
};
