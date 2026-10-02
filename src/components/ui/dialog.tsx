"use client";

import { Dialog as D, AlertDialog as AD, VisuallyHidden } from "radix-ui";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

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
          "fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-24px)] -translate-x-1/2 rounded-xl border border-border-strong bg-surface-2 shadow-lg outline-none data-[state=open]:animate-pop-in",
          sizes[size],
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-4">
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
        <div className="px-5 pb-5 pt-3">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-5 flex items-center justify-end gap-2", className)} {...props} />;
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
        <AD.Content className="fixed left-1/2 top-[18vh] z-50 w-[calc(100vw-24px)] max-w-md -translate-x-1/2 rounded-xl border border-border-strong bg-surface-2 p-5 shadow-lg data-[state=open]:animate-pop-in">
          <AD.Title className="text-[15px] font-semibold">{title}</AD.Title>
          <AD.Description asChild>
            <div className="mt-2 text-[13px] leading-relaxed text-fg-muted">{description}</div>
          </AD.Description>
          {children}
          <div className="mt-5 flex justify-end gap-2">
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
