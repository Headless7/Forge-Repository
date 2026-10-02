import { Slot } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const variants = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover shadow-sm",
  secondary: "bg-surface-3 text-fg hover:bg-surface-4 border border-border-strong/60",
  outline: "border border-border-strong text-fg hover:bg-surface-3",
  ghost: "text-fg-muted hover:text-fg hover:bg-surface-3",
  danger: "bg-danger text-white hover:brightness-110 shadow-sm",
  "danger-ghost": "text-danger hover:bg-danger/10",
  success: "bg-state-approved text-white hover:brightness-110 shadow-sm",
  link: "text-accent hover:underline underline-offset-2 px-0 h-auto",
} as const;

const sizes = {
  xs: "h-6 px-2 text-xs gap-1 rounded-[5px]",
  sm: "h-7 px-2.5 text-[13px] gap-1.5 rounded-md",
  md: "h-8 px-3 text-sm gap-2 rounded-md",
  lg: "h-10 px-4 text-sm gap-2 rounded-lg",
  icon: "h-8 w-8 rounded-md",
  "icon-sm": "h-7 w-7 rounded-md",
  "icon-xs": "h-6 w-6 rounded-[5px]",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
  asChild?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "secondary", size = "md", asChild, loading, disabled, children, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? "button")}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,color,box-shadow,filter] duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {loading ? <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}
          {children}
        </>
      )}
    </Comp>
  );
});
