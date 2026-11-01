import { Dialog as BDialog } from "@base-ui/react/dialog";
import { Menu as BMenu } from "@base-ui/react/menu";
import { Popover as BPopover } from "@base-ui/react/popover";
import { Tooltip as BTooltip } from "@base-ui/react/tooltip";
import { X } from "lucide-react";
import { type CSSProperties, type ReactElement, type ReactNode, type RefObject, useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

/* --------------------------------- Dialog --------------------------------- */

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  hideClose,
  bare,
  testId,
  style,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  hideClose?: boolean;
  /** No padding/header — the child renders its own layout. */
  bare?: boolean;
  testId?: string;
  style?: CSSProperties;
}) {
  return (
    <BDialog.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
      <BDialog.Portal>
        <BDialog.Backdrop className="fixed inset-0 z-50 bg-scrim transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <BDialog.Popup
          data-testid={testId}
          style={style}
          className={cn(
            "air-raised fixed top-1/2 left-1/2 z-50 max-h-[calc(100vh-48px)] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[22px] border border-border-strong/60 bg-elevated shadow-dialog outline-none motion-spring data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
            !bare && "flex flex-col",
            className,
          )}
        >
          {!bare && (title || !hideClose) && (
            <div className="flex items-start gap-3 px-5 pt-5 pb-1">
              <div className="min-w-0 flex-1">
                {title && (
                  <BDialog.Title className="font-semibold text-lg tracking-[-0.01em]">{title}</BDialog.Title>
                )}
                {description && (
                  <BDialog.Description className="mt-1 text-muted text-sm">{description}</BDialog.Description>
                )}
              </div>
              {!hideClose && (
                <BDialog.Close
                  aria-label="Close"
                  className="-mt-1 -mr-1 grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  <X className="size-4" />
                </BDialog.Close>
              )}
            </div>
          )}
          {children}
        </BDialog.Popup>
      </BDialog.Portal>
    </BDialog.Root>
  );
}

export const DialogClose = BDialog.Close;
export const DialogTitle = BDialog.Title;
export const DialogDescription = BDialog.Description;

/**
 * A modal surface the caller lays out and places itself (the workspace sheet, the full-screen computer): focus
 * moves in and is trapped, Escape closes it, the page behind is inert, and focus returns to what opened it.
 * `onEscape` may return false to keep it open (a terminal inside it wants Escape for itself).
 */
export function Sheet({
  open,
  onOpenChange,
  label,
  children,
  className,
  backdropClassName,
  initialFocus,
  keepOnOutsidePress,
  testId,
  style,
}: {
  open: boolean;
  onOpenChange: (open: boolean, reason?: string, event?: Event) => void;
  label: string;
  children: ReactNode;
  className?: string;
  /** No backdrop when omitted (the surface covers the window). */
  backdropClassName?: string;
  initialFocus?: RefObject<HTMLElement | null>;
  /** A press outside (a toast over it) doesn't close it. */
  keepOnOutsidePress?: boolean;
  testId?: string;
  style?: CSSProperties;
}) {
  return (
    <BDialog.Root
      open={open}
      disablePointerDismissal={keepOnOutsidePress}
      onOpenChange={(o, d) => onOpenChange(o, d.reason, d.event)}
    >
      <BDialog.Portal>
        {backdropClassName && <BDialog.Backdrop className={backdropClassName} />}
        <BDialog.Popup
          data-testid={testId}
          aria-label={label}
          initialFocus={initialFocus}
          className={cn("outline-none", className)}
          style={style}
        >
          {children}
        </BDialog.Popup>
      </BDialog.Portal>
    </BDialog.Root>
  );
}

/**
 * "Archive Pico?": one plain question, what it costs, Cancel (focused first) and the action, named for what it does.
 * For one-click actions that can't be undone.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  action,
  onConfirm,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: ReactNode;
  action: string;
  onConfirm: () => unknown;
  testId?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      hideClose
      testId={testId ?? "confirm-dialog"}
    >
      <p className="px-5 pt-1 text-fg-2 text-sm leading-relaxed">{body}</p>
      <div className="flex justify-end gap-2 px-5 pt-4 pb-5">
        {/* First in the dialog, so it has focus when it opens: Enter or Escape never destroys anything. */}
        <BDialog.Close render={<Button variant="secondary" data-testid="confirm-cancel" />}>
          Cancel
        </BDialog.Close>
        <Button
          variant="danger"
          disabled={busy}
          data-testid="confirm-action"
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
              onOpenChange(false);
            }
          }}
        >
          {action}
        </Button>
      </div>
    </Modal>
  );
}

/* --------------------------------- Popover -------------------------------- */

export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  side = "bottom",
  align = "start",
  sideOffset = 8,
  className,
  label,
  keepSide,
}: {
  trigger: ReactElement;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
  /** The popover's name for screen readers ("Yo’s profile", "Team"). */
  label?: string;
  /** Always on `side` (never flipped): it caps its own height to the room there (`--available-height`). */
  keepSide?: boolean;
}) {
  return (
    <BPopover.Root open={open} onOpenChange={onOpenChange ? (o) => onOpenChange(o) : undefined}>
      <BPopover.Trigger render={trigger} />
      <BPopover.Portal>
        <BPopover.Positioner
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={12}
          collisionAvoidance={
            keepSide ? { side: "none", align: "shift", fallbackAxisSide: "none" } : undefined
          }
          className="z-50"
        >
          <BPopover.Popup
            aria-label={label}
            className={cn(
              "air-overlay origin-[var(--transform-origin)] rounded-2xl border border-border-strong/60 bg-elevated shadow-pop outline-none motion-spring data-[ending-style]:scale-[0.96] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.95] data-[starting-style]:opacity-0",
              className,
            )}
          >
            {children}
          </BPopover.Popup>
        </BPopover.Positioner>
      </BPopover.Portal>
    </BPopover.Root>
  );
}

export const PopoverClose = BPopover.Close;

/* --------------------------------- Tooltip -------------------------------- */

export const TooltipProvider = BTooltip.Provider;

export function Tip({
  label,
  children,
  side = "top",
  shortcut,
}: {
  label: ReactNode;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  shortcut?: string;
}) {
  return (
    <BTooltip.Root>
      <BTooltip.Trigger render={children} />
      <BTooltip.Portal>
        <BTooltip.Positioner side={side} sideOffset={7} className="z-[60]">
          <BTooltip.Popup className="flex items-center gap-2 rounded-lg border border-border-strong/50 bg-elevated px-2 py-1 text-fg text-xs shadow-pop transition-[opacity,transform] duration-100 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
            {label}
            {shortcut && <span className="text-muted">{shortcut}</span>}
          </BTooltip.Popup>
        </BTooltip.Positioner>
      </BTooltip.Portal>
    </BTooltip.Root>
  );
}

/* ---------------------------------- Menu ---------------------------------- */

export function Menu({
  trigger,
  children,
  side = "bottom",
  align = "end",
  sideOffset = 6,
  className,
  testId,
}: {
  trigger: ReactElement;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
  testId?: string;
}) {
  return (
    <BMenu.Root>
      <BMenu.Trigger render={trigger} />
      <BMenu.Portal>
        <BMenu.Positioner
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={12}
          className="z-50"
        >
          <BMenu.Popup
            data-testid={testId}
            className={cn(
              "air-overlay min-w-44 origin-[var(--transform-origin)] rounded-2xl border border-border-strong/60 bg-elevated p-1.5 shadow-pop outline-none motion-spring data-[ending-style]:translate-y-[3px] data-[ending-style]:opacity-0 data-[starting-style]:translate-y-[5px] data-[starting-style]:opacity-0",
              className,
            )}
          >
            {children}
          </BMenu.Popup>
        </BMenu.Positioner>
      </BMenu.Portal>
    </BMenu.Root>
  );
}

export function MenuItem({
  children,
  onClick,
  danger,
  icon,
  trailing,
  testId,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  icon?: ReactNode;
  trailing?: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <BMenu.Item
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "flex h-8 select-none items-center gap-2.5 rounded-[10px] px-2.5 text-base outline-none data-[highlighted]:bg-hover [&_svg]:size-4 [&_svg]:text-muted",
        danger ? "text-danger [&_svg]:text-danger" : "text-fg",
        className,
      )}
    >
      {icon}
      {children}
      {trailing && <span className="ml-auto flex items-center">{trailing}</span>}
    </BMenu.Item>
  );
}

export function MenuSeparator() {
  return <div className="mx-1.5 my-1.5 h-px bg-border-strong" />;
}
