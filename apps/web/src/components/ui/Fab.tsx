import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * The round "+" button floating at the bottom right of Tasks and Make. Above the phone tab bar on small screens
 * (`.fab` in styles.css).
 */
export function Fab({
  label,
  onClick,
  icon,
  open,
  testId,
}: {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  /** A menu it opens is showing: the + turns into an ×. */
  open?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className={cn("fab", open && "is-open")}
      aria-label={label}
      aria-expanded={open}
      onClick={onClick}
      data-testid={testId ?? "fab"}
    >
      {icon ?? <Plus />}
    </button>
  );
}
