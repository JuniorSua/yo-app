import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "brand" | "outline" | "subtle";
type Size = "xs" | "sm" | "md" | "lg" | "icon" | "icon-sm" | "icon-lg";

const variants: Record<Variant, string> = {
  primary: "bg-fg text-bg hover:bg-fg/88 active:bg-fg/80 shadow-soft",
  brand: "bg-brand text-brand-fg hover:brightness-[1.04] active:brightness-95 shadow-soft",
  secondary:
    "air-raised bg-elevated text-fg border border-border-strong/70 hover:bg-hover hover:border-border-strong shadow-soft",
  outline: "border border-border-strong text-fg hover:bg-hover",
  ghost: "text-fg-2 hover:text-fg hover:bg-hover active:bg-active",
  subtle: "bg-active/60 text-fg hover:bg-active",
  danger: "bg-danger/12 text-danger hover:bg-danger/18 border border-danger/20",
};

const sizes: Record<Size, string> = {
  xs: "h-6 px-2 text-xs gap-1 rounded-md",
  sm: "h-7 px-2.5 text-sm gap-1.5 rounded-[9px]",
  md: "h-8 px-3 text-base gap-2 rounded-[11px]",
  lg: "h-10 px-4 text-md gap-2 rounded-[13px]",
  "icon-sm": "size-7 rounded-lg",
  icon: "size-8 rounded-[10px]",
  "icon-lg": "size-10 rounded-xl",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

/** A Button's classes, for things that must be another element (a real link: `<a target="_blank">`). */
export function buttonClass(variant: Variant = "secondary", size: Size = "md", className?: string) {
  return cn(
    "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium outline-none transition-[background-color,border-color,color,box-shadow,filter,opacity,scale] duration-150 focus-visible:ring-2 focus-visible:ring-link/60 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0",
    variants[variant],
    sizes[size],
    className,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, type = "button", ...props },
  ref,
) {
  return <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...props} />;
});

/**
 * A round, finger-sized answer button, half a card wide (two side by side): Refuse · Allow once. `primary` is the
 * dark, inverted one.
 */
export const PillButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }
>(function PillButton({ primary, className, type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex min-h-11 min-w-0 flex-1 basis-28 select-none items-center justify-center gap-2 rounded-full px-4 py-2 font-semibold text-[14px] tracking-[-0.006em] outline-none transition-[background-color,box-shadow,filter,scale,opacity] duration-150 focus-visible:ring-2 focus-visible:ring-link/60 focus-visible:ring-offset-2 focus-visible:ring-offset-card active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        primary
          ? "bg-fg text-bg shadow-soft hover:brightness-125 dark:hover:brightness-90"
          : "text-fg shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-hover",
        className,
      )}
      {...props}
    />
  );
});
