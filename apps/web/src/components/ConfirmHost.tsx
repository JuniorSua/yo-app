import { useRef } from "react";
import { type ConfirmRequest, useUI } from "../stores/ui";
import { ConfirmDialog } from "./ui/overlay";

/**
 * The app's one confirm dialog for actions asked from a menu or popover that closes when the dialog opens (the
 * Team popover's Archive). Dialogs that stay open (Settings, a page) render their own ConfirmDialog.
 */
export function ConfirmHost() {
  const request = useUI((s) => s.confirm);
  // Keeps its words while it fades out.
  const last = useRef<ConfirmRequest | null>(null);
  if (request) last.current = request;
  const c = request ?? last.current;
  return (
    <ConfirmDialog
      open={!!request}
      onOpenChange={(open) => !open && useUI.setState({ confirm: null })}
      title={c?.title ?? ""}
      body={c?.body ?? ""}
      action={c?.action ?? ""}
      onConfirm={() => c?.run()}
    />
  );
}
