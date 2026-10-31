import type { PendingRequest } from "@yo/contracts";
import { TriangleAlert } from "lucide-react";

/** "a, b and c". */
export function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/**
 * On an approval card: what core's check found that looks sensitive in what Yo is about to send (a card number,
 * a password, a health detail…), so the user looks before they allow it. Nothing found, nothing shown.
 */
export function SensitiveWarning({ items }: { items: PendingRequest["sensitive"] }) {
  if (!items?.length) return null;
  return (
    <div data-testid="sensitive-warning" className="ycard-warning is-sensitive">
      <TriangleAlert aria-hidden />
      <p>
        <span className="font-semibold">Before you allow this:</span> it includes{" "}
        {joinLabels(items.map((i) => i.label))}. Check that's meant to go out.
      </p>
    </div>
  );
}
