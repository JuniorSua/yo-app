import { type ComponentPropsWithoutRef, isValidElement, type ReactNode, useRef } from "react";
import { cn } from "../../lib/utils";
import { CopyButton } from "../ui/CopyButton";
import { codeKind, fenceLang, kindLabel } from "./codeKind";

/** The inner `<code>`'s tag and text, as react-markdown renders a fence. */
function fenceParts(children: ReactNode): { lang?: string; body: string } {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return { body: "" };
  const inner = children.props.children;
  return { lang: fenceLang(children.props.className), body: typeof inner === "string" ? inner : "" };
}

/**
 * A fenced block in a reply: a card with a small label and its own Copy button on a bar above the text, so the
 * button never covers it. Messages and notes read as normal wrapped text; code and commands stay monospaced but
 * wrap too, so nothing scrolls sideways.
 */
export function CodeBlock({ children, className, ...props }: ComponentPropsWithoutRef<"pre">) {
  const pre = useRef<HTMLPreElement>(null);
  const { lang, body } = fenceParts(children);
  const kind = codeKind(lang, body);
  return (
    <div className="code-card" data-testid="code-block" data-kind={kind}>
      <div className="code-card-bar">
        <span className="code-card-label">{kindLabel(kind, lang)}</span>
        <CopyButton
          text={() => (pre.current?.textContent ?? "").replace(/\n$/, "")}
          label={kind === "text" ? "Copy text" : "Copy code"}
          testId="copy-code"
        />
      </div>
      <pre ref={pre} {...props} className={cn(className, kind === "text" && "is-text")}>
        {children}
      </pre>
    </div>
  );
}
