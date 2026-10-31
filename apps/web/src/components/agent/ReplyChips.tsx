import { CornerDownRight } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * Quick replies (suggest_replies) under the agent's question: 2 or 3 chips that build in one after another. A tap
 * sends the reply as the user's message; the chosen chip stays highlighted and the others grey out.
 */
export function ReplyChips({
  replies,
  chosen,
  onPick,
}: {
  replies: string[];
  /** The reply the user tapped: the chips can't be tapped again. */
  chosen: string | null;
  onPick: (reply: string) => void;
}) {
  return (
    <fieldset aria-label="Suggested replies" className="chat-reply-chips" data-testid="reply-chips">
      {replies.map((r, i) => {
        const picked = r === chosen;
        return (
          <button
            key={r}
            type="button"
            disabled={chosen !== null}
            onClick={() => onPick(r)}
            data-testid="reply-chip"
            data-chosen={picked || undefined}
            style={{ animationDelay: `${i * 70}ms` }}
            className={cn("chat-reply-chip animate-rise", chosen !== null && !picked && "is-faded")}
          >
            <CornerDownRight aria-hidden />
            <span className="truncate">{r}</span>
          </button>
        );
      })}
    </fieldset>
  );
}
