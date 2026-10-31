import { newRequestKey } from "../lib/useShortcuts";
import { modKey } from "../lib/utils";
import { useUI } from "../stores/ui";
import { Kbd } from "./ui/controls";
import { Modal } from "./ui/overlay";

/** Every keyboard shortcut, in one sheet (⌘/ or the palette's "Keyboard shortcuts"). */
export function shortcutGroups(): { title: string; items: { keys: string[]; label: string }[] }[] {
  return [
    {
      title: "Anywhere",
      items: [
        { keys: [`${modKey}K`], label: "Search and commands" },
        { keys: [newRequestKey()], label: "New request" },
        { keys: [`${modKey}⇧M`], label: "Switch Work ↔ Personal" },
        { keys: [`${modKey}\\`], label: "Show or hide the inspector" },
        { keys: [`${modKey}.`], label: "Open or close the agent’s computer" },
        { keys: [`${modKey},`], label: "Settings" },
        { keys: [`${modKey}/`], label: "These shortcuts" },
        { keys: ["Esc"], label: "Close" },
      ],
    },
    {
      title: "Writing a message",
      items: [
        { keys: ["Enter"], label: "Send" },
        { keys: ["⇧Enter"], label: "New line" },
        { keys: [`${modKey}Enter`], label: "Send now, while Yo is working" },
        { keys: ["/"], label: "Commands" },
        { keys: [">", "Space"], label: "Start a quote" },
      ],
    },
  ];
}

export function ShortcutsDialog() {
  const open = useUI((s) => s.shortcutsOpen);
  return (
    <Modal
      open={open}
      onOpenChange={(o) => useUI.setState({ shortcutsOpen: o })}
      title="Keyboard shortcuts"
      testId="shortcuts-dialog"
    >
      <div className="space-y-5 px-5 pt-2 pb-5">
        {shortcutGroups().map((g) => (
          <section key={g.title}>
            <h3 className="mb-1.5 font-medium text-muted text-xs uppercase tracking-wide">{g.title}</h3>
            <ul className="divide-y divide-border/60">
              {g.items.map((it) => (
                <li key={it.label} className="flex items-center justify-between gap-4 py-2 text-sm">
                  <span>{it.label}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {it.keys.map((k) => (
                      <Kbd key={k} className="h-[22px] min-w-[22px] px-1.5 text-xs">
                        {k}
                      </Kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
