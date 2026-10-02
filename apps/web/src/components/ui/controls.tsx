import { Select as BSelect } from "@base-ui/react/select";
import { Switch as BSwitch } from "@base-ui/react/switch";
import { Check, ChevronsUpDown } from "lucide-react";
import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full rounded-[10px] border border-border-strong/70 bg-bg/60 px-3 text-base text-fg outline-none transition-[border-color,box-shadow] duration-150 focus:border-link/60 focus:ring-3 focus:ring-link/15",
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "min-h-20 w-full resize-none rounded-[10px] border border-border-strong/70 bg-bg/60 px-3 py-2 text-base text-fg leading-relaxed outline-none transition-[border-color,box-shadow] duration-150 focus:border-link/60 focus:ring-3 focus:ring-link/15",
          className,
        )}
        {...props}
      />
    );
  },
);

export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className="block space-y-1.5">
      <span className="block font-medium text-fg-2 text-sm">{label}</span>
      {children}
      {hint && <span className="block text-muted text-xs">{hint}</span>}
    </label>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  size = "md",
  disabled,
  testId,
  describedBy,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  testId?: string;
  /** id of the element describing this switch (e.g. the row's sub-text). */
  describedBy?: string;
}) {
  return (
    <BSwitch.Root
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v)}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full border border-transparent bg-active outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-link/60 data-[checked]:bg-success data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45",
        size === "sm" ? "h-[18px] w-[30px]" : "h-[22px] w-[38px]",
      )}
    >
      <BSwitch.Thumb
        className={cn(
          "block rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.3)] transition-transform duration-200 ease-out-soft",
          size === "sm"
            ? "size-[14px] translate-x-[1px] data-[checked]:translate-x-[13px]"
            : "size-[18px] translate-x-[1px] data-[checked]:translate-x-[17px]",
        )}
      />
    </BSwitch.Root>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-border-strong/70 bg-bg/40 px-1 font-sans text-2xs text-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("size-3.5 animate-[spin_0.8s_linear_infinite]", className)}
      viewBox="0 0 16 16"
      fill="none"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "success" | "warning" | "danger" | "link";
  className?: string;
}) {
  const tones = {
    neutral: "bg-active text-fg-2",
    brand: "bg-brand/15 text-brand-ink",
    success: "bg-success/14 text-success",
    warning: "bg-warning/15 text-warning",
    danger: "bg-danger/14 text-danger",
    link: "bg-link/14 text-link",
  };
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 font-medium text-2xs",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; icon?: ReactNode }[];
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={cn("inline-flex rounded-[10px] bg-active/70 p-0.5", className)} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 font-medium transition-all duration-150 [&_svg]:size-3.5",
            size === "sm" ? "h-6 text-xs" : "h-7 text-sm",
            value === o.value ? "bg-elevated text-fg shadow-soft" : "text-muted hover:text-fg",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
  placeholder,
  testId,
  label,
  disabled,
}: {
  value: T | null;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; icon?: ReactNode; description?: string }[];
  className?: string;
  placeholder?: string;
  testId?: string;
  /** Accessible name when there is no visible label. */
  label?: string;
  disabled?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <BSelect.Root value={value} disabled={disabled} onValueChange={(v) => v !== null && onChange(v as T)}>
      <BSelect.Trigger
        data-testid={testId}
        aria-label={label}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-[10px] border border-border-strong/70 bg-bg/60 px-3 text-left text-base outline-none transition-colors hover:border-border-strong focus-visible:border-link/60 focus-visible:ring-3 focus-visible:ring-link/15 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
          className,
        )}
      >
        {current?.icon}
        <span className={cn("min-w-0 flex-1 truncate", !current && "text-faint")}>
          {current?.label ?? placeholder ?? "Select…"}
        </span>
        <ChevronsUpDown className="size-3.5 text-muted" />
      </BSelect.Trigger>
      <BSelect.Portal>
        <BSelect.Positioner sideOffset={6} alignItemWithTrigger={false} className="z-[70]">
          <BSelect.Popup className="scroll-fade max-h-80 min-w-[var(--anchor-width)] overflow-y-auto rounded-xl [--scroll-fade:12px] border border-border-strong/60 bg-elevated p-1 shadow-pop outline-none transition-[opacity,transform] duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
            {options.map((o) => (
              <BSelect.Item
                key={o.value}
                value={o.value}
                className="flex min-h-8 select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-base outline-none data-[highlighted]:bg-hover"
              >
                {o.icon}
                <div className="min-w-0 flex-1">
                  <BSelect.ItemText>{o.label}</BSelect.ItemText>
                  {o.description && <div className="text-muted text-xs">{o.description}</div>}
                </div>
                <BSelect.ItemIndicator>
                  <Check className="size-3.5 text-fg" />
                </BSelect.ItemIndicator>
              </BSelect.Item>
            ))}
          </BSelect.Popup>
        </BSelect.Positioner>
      </BSelect.Portal>
    </BSelect.Root>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-2xl border border-border bg-card shadow-card", className)}>{children}</div>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("px-1 font-medium text-2xs text-muted uppercase tracking-[0.08em]", className)}>
      {children}
    </div>
  );
}
