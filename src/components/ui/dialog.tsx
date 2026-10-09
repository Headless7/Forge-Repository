"use client";

import { Dialog as D, AlertDialog as AD, VisuallyHidden } from "radix-ui";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

/**
 * Every dialog fits the window: it starts 12% down (near the top on short windows), is never taller
 * than the space left, and its body scrolls while the header and footer actions stay in view.
 */
const fitWindow =
  "max-h-[calc(88dvh-12px)] top-[12dvh] [@media(max-height:640px)]:top-3 [@media(max-height:640px)]:max-h-[calc(100dvh-24px)]";

const sizes = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
} as const;

export function DialogContent({
  className,
  children,
  title,
  description,
  size = "md",
  hideTitle,
  ...props
}: ComponentProps<typeof D.Content> & { title: ReactNode; description?: ReactNode; size?: keyof typeof sizes; hideTitle?: boolean }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
      <D.Content
        className={cn(
          "fixed left-1/2 z-50 flex w-[calc(100vw-24px)] -translate-x-1/2 flex-col rounded-xl border border-border-strong bg-surface-2 shadow-lg outline-none data-[state=open]:animate-pop-in",
          fitWindow,
          sizes[size],
          className,
        )}
        {...props}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-5 pt-4">
          {hideTitle ? (
            <VisuallyHidden.Root>
              <D.Title>{title}</D.Title>
            </VisuallyHidden.Root>
          ) : (
            <div className="min-w-0">
              <D.Title className="text-[15px] font-semibold text-fg">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-[13px] text-fg-muted">{description}</D.Description> : null}
            </div>
          )}
          <D.Close asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close" className="-mr-2 -mt-1">
              <X />
            </Button>
          </D.Close>
        </div>
        {!description ? <D.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</D.Description> : null}
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-3">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

/** The dialog's actions: pinned to the bottom while a long body scrolls (keep it last in the body). -bottom-5 cancels the body's bottom padding, which sticky positioning otherwise keeps clear. */
export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("sticky -bottom-5 z-[1] -mx-5 -mb-5 mt-2 flex flex-wrap items-center justify-end gap-2 bg-surface-2 px-5 pb-5 pt-3", className)} {...props} />;
}

/** Side sheet (notifications, mobile navigation). */
export function SheetContent({
  side = "right",
  className,
  children,
  title,
  ...props
}: ComponentProps<typeof D.Content> & { side?: "left" | "right"; title: string }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
      <D.Content
        className={cn(
          "fixed inset-y-0 z-50 flex w-[min(420px,100vw)] flex-col border-border-strong bg-surface shadow-lg outline-none data-[state=open]:animate-fade-in",
          side === "right" ? "right-0 border-l" : "left-0 border-r",
          className,
        )}
        {...props}
      >
        <VisuallyHidden.Root>
          <D.Title>{title}</D.Title>
          <D.Description>{title}</D.Description>
        </VisuallyHidden.Root>
        {children}
      </D.Content>
    </D.Portal>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
  confirmDisabled?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  destructive,
  loading,
  onConfirm,
  children,
  confirmDisabled,
}: ConfirmDialogProps) {
  return (
    <AD.Root open={open} onOpenChange={onOpenChange}>
      <AD.Portal>
        <AD.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
        <AD.Content
          className={cn(
            "fixed left-1/2 z-50 flex w-[calc(100vw-24px)] max-w-md -translate-x-1/2 flex-col rounded-xl border border-border-strong bg-surface-2 shadow-lg data-[state=open]:animate-pop-in",
            "max-h-[calc(82dvh-12px)] top-[18dvh] [@media(max-height:640px)]:top-3 [@media(max-height:640px)]:max-h-[calc(100dvh-24px)]",
          )}
        >
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-5">
            <AD.Title className="text-[15px] font-semibold">{title}</AD.Title>
            <AD.Description asChild>
              <div className="mt-2 text-[13px] leading-relaxed text-fg-muted">{description}</div>
            </AD.Description>
            {children}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2 px-5 pb-5 pt-5">
            <AD.Cancel asChild>
              <Button variant="ghost">Cancel</Button>
            </AD.Cancel>
            <Button
              variant={destructive ? "danger" : "primary"}
              loading={loading}
              disabled={confirmDisabled}
              onClick={(e) => {
                e.preventDefault();
                onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AD.Content>
      </AD.Portal>
    </AD.Root>
  );
}
