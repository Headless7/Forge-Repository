"use client";

import { Checkbox as C, Select as S, Switch as Sw, Tabs as Tb } from "radix-ui";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Checkbox({ className, ...props }: ComponentProps<typeof C.Root>) {
  return (
    <C.Root
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-border-strong bg-surface-3 transition-colors hover:border-fg-subtle data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <C.Indicator>
        <Check className="size-3 text-accent-fg" strokeWidth={3} />
      </C.Indicator>
    </C.Root>
  );
}

export function Switch({ className, ...props }: ComponentProps<typeof Sw.Root>) {
  return (
    <Sw.Root
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full border border-border-strong bg-surface-4 transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <Sw.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[17px]" />
    </Sw.Root>
  );
}

export interface SelectOption<V extends string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

/**
 * Where floating layers (select menus) render. Defaults to <body>; a surface that can go
 * fullscreen provides its own element while it is fullscreen — only that element's subtree
 * is drawn then, so a menu portalled to <body> would be invisible.
 */
export const PortalContainer = createContext<HTMLElement | null>(null);

/**
 * A select built on Radix: the menu is regular DOM drawn with the theme tokens, so every
 * state (normal, highlighted, selected, focused, disabled) is readable in both themes.
 * (Native <select> menus are drawn by the OS: on Windows Chrome/Edge they composite a
 * transparent field onto a light popup, so light text on dark controls becomes invisible.)
 *
 * `variant="media"` is for controls floating over always-dark media (3D viewer, video): the
 * trigger is translucent dark and the menu uses the dark tokens whatever the app theme.
 */
export function Select<V extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  contentClassName,
  disabled,
  variant = "default",
  title,
  "aria-label": ariaLabel,
}: {
  value: V | undefined;
  onValueChange: (value: V) => void;
  options: Array<SelectOption<V>>;
  placeholder?: string;
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
  variant?: "default" | "media";
  title?: string;
  "aria-label"?: string;
}) {
  const container = useContext(PortalContainer);
  const media = variant === "media";
  return (
    <S.Root value={value} onValueChange={(v) => onValueChange(v as V)} disabled={disabled}>
      <S.Trigger
        aria-label={ariaLabel}
        title={title}
        className={cn(
          "inline-flex items-center justify-between gap-2 rounded-md border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-fg-subtle",
          media
            ? "h-7 border-white/15 bg-black/45 px-2 text-[12px] text-white hover:border-white/30 hover:bg-black/60 focus-visible:border-white/40 data-[state=open]:border-white/40 data-[placeholder]:text-white/60 [&_svg]:size-3.5"
            : "h-8 w-full border-border-strong/70 bg-surface-3/60 px-2.5 text-sm text-fg hover:border-border-strong focus:border-accent [&_svg]:size-4",
          className,
        )}
      >
        <span className="min-w-0 truncate text-left">
          <S.Value placeholder={placeholder} />
        </span>
        <S.Icon className="shrink-0">
          <ChevronDown className={media ? "text-white/70" : "text-fg-subtle"} />
        </S.Icon>
      </S.Trigger>
      <S.Portal container={container ?? undefined}>
        <S.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          data-theme={media ? "dark" : undefined}
          className={cn(
            "z-[60] max-h-[min(18rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] max-w-[min(24rem,calc(100vw-16px))] overflow-hidden rounded-lg border border-border-strong bg-surface-2 p-1 text-fg shadow-lg data-[state=open]:animate-pop-in",
            contentClassName,
          )}
        >
          <S.ScrollUpButton className="flex h-5 items-center justify-center text-fg-muted [&_svg]:size-3.5">
            <ChevronUp />
          </S.ScrollUpButton>
          <S.Viewport>
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-md py-1.5 pl-7 pr-2 text-[13px] text-fg outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-surface-4 data-[state=checked]:font-medium data-[disabled]:text-fg-subtle [&_svg]:size-4"
              >
                <S.ItemIndicator className="absolute left-2">
                  <Check className="text-accent" />
                </S.ItemIndicator>
                {o.icon}
                <S.ItemText>{o.label}</S.ItemText>
              </S.Item>
            ))}
          </S.Viewport>
          <S.ScrollDownButton className="flex h-5 items-center justify-center text-fg-muted [&_svg]:size-3.5">
            <ChevronDown />
          </S.ScrollDownButton>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}

export const Tabs = Tb.Root;
export const TabsContent = Tb.Content;

export function TabsList({ className, ...props }: ComponentProps<typeof Tb.List>) {
  return <Tb.List className={cn("flex items-center gap-1 border-b border-border", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof Tb.Trigger>) {
  return (
    <Tb.Trigger
      className={cn(
        "relative -mb-px flex h-9 items-center gap-1.5 border-b-2 border-transparent px-2.5 text-[13px] font-medium text-fg-muted outline-none transition-colors hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg [&_svg]:size-4",
        className,
      )}
      {...props}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-surface-3", className)} />;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded border border-border-strong bg-surface-3 px-1 font-mono text-[10px] text-fg-muted", className)}>
      {children}
    </kbd>
  );
}

export function Badge({ className, children, tone = "neutral" }: { className?: string; children: ReactNode; tone?: "neutral" | "accent" | "danger" | "success" | "warning" }) {
  const tones = {
    neutral: "bg-surface-4 text-fg-muted",
    accent: "bg-accent-soft text-accent",
    danger: "bg-danger/15 text-danger",
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
  };
  return <span className={cn("inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium", tones[tone], className)}>{children}</span>;
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong px-6 py-10 text-center", className)}>
      {icon ? <div className="mb-3 text-fg-subtle [&_svg]:size-6">{icon}</div> : null}
      <p className="text-sm font-medium text-fg">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-[13px] text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
