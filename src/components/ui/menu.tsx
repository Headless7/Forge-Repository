"use client";

import { DropdownMenu as M, Popover as P, Tooltip as T } from "radix-ui";
import { Check, ChevronRight } from "lucide-react";
import { useContext, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PortalContainer } from "./controls";

const panel =
  "z-50 min-w-44 overflow-hidden rounded-lg border border-border-strong bg-surface-2 p-1 text-[13px] text-fg shadow-lg data-[state=open]:animate-pop-in";
const item =
  "relative flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-surface-4 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-muted";

export const DropdownMenu = M.Root;
export const DropdownMenuTrigger = M.Trigger;
export const DropdownMenuSub = M.Sub;
export const DropdownMenuGroup = M.Group;
export const DropdownMenuRadioGroup = M.RadioGroup;

export function DropdownMenuContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal container={useContext(PortalContainer) ?? undefined}>
      <M.Content sideOffset={sideOffset} className={cn(panel, className)} {...props} />
    </M.Portal>
  );
}

export function DropdownMenuItem({
  className,
  destructive,
  shortcut,
  children,
  ...props
}: ComponentProps<typeof M.Item> & { destructive?: boolean; shortcut?: string }) {
  return (
    <M.Item className={cn(item, destructive && "text-danger [&_svg]:text-danger data-[highlighted]:bg-danger/10", className)} {...props}>
      {/* With asChild the item becomes its one child (e.g. a link): a second child — even an absent
          shortcut — makes the slot throw and takes the whole page down when the menu opens. */}
      {props.asChild ? (
        children
      ) : (
        <>
          {children}
          {shortcut ? <span className="ml-auto pl-4 text-[11px] text-fg-subtle">{shortcut}</span> : null}
        </>
      )}
    </M.Item>
  );
}

export function DropdownMenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof M.CheckboxItem>) {
  return (
    <M.CheckboxItem className={cn(item, "pl-7", className)} {...props}>
      <M.ItemIndicator className="absolute left-2 flex items-center">
        <Check className="!text-accent" />
      </M.ItemIndicator>
      {children}
    </M.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem className={cn(item, "pl-7", className)} {...props}>
      <M.ItemIndicator className="absolute left-2 flex items-center">
        <Check className="!text-accent" />
      </M.ItemIndicator>
      {children}
    </M.RadioItem>
  );
}

export function DropdownMenuSubTrigger({ className, children, ...props }: ComponentProps<typeof M.SubTrigger>) {
  return (
    <M.SubTrigger className={cn(item, "data-[state=open]:bg-surface-4", className)} {...props}>
      {children}
      <ChevronRight className="ml-auto" />
    </M.SubTrigger>
  );
}

export function DropdownMenuSubContent({ className, ...props }: ComponentProps<typeof M.SubContent>) {
  return (
    <M.Portal container={useContext(PortalContainer) ?? undefined}>
      <M.SubContent className={cn(panel, className)} sideOffset={4} {...props} />
    </M.Portal>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof M.Label>) {
  return <M.Label className={cn("px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-subtle", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof M.Separator>) {
  return <M.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

// ── Popover ──────────────────────────────────────────────────────────────────
export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

export function PopoverContent({ className, sideOffset = 6, align = "start", ...props }: ComponentProps<typeof P.Content>) {
  return (
    <P.Portal container={useContext(PortalContainer) ?? undefined}>
      <P.Content
        sideOffset={sideOffset}
        align={align}
        className={cn("z-50 rounded-lg border border-border-strong bg-surface-2 p-3 text-[13px] text-fg shadow-lg outline-none data-[state=open]:animate-pop-in", className)}
        {...props}
      />
    </P.Portal>
  );
}

// ── Tooltip ─────────────────────────────────────────────────────────────────
export const TooltipProvider = T.Provider;

export function Tooltip({
  content,
  children,
  side = "top",
  shortcut,
  delay,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  shortcut?: string;
  delay?: number;
}) {
  const container = useContext(PortalContainer);
  if (!content) return <>{children}</>;
  return (
    <T.Root delayDuration={delay}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal container={container ?? undefined}>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-[60] flex max-w-72 items-center gap-2 rounded-md border border-border-strong bg-surface-4 px-2 py-1 text-xs text-fg shadow-md data-[state=delayed-open]:animate-fade-in"
        >
          {content}
          {shortcut ? <kbd className="rounded border border-border-strong bg-surface-3 px-1 font-mono text-[10px] text-fg-muted">{shortcut}</kbd> : null}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
