import { forwardRef, useLayoutEffect, useImperativeHandle, useRef, type InputHTMLAttributes, type LabelHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const field =
  "w-full rounded-md border border-border-strong/70 bg-surface-3/60 px-2.5 text-sm text-fg outline-none transition-colors placeholder:text-fg-subtle hover:border-border-strong focus:border-accent focus:bg-surface-3 focus:ring-2 focus:ring-accent/25 disabled:opacity-60 aria-invalid:border-danger";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(field, "h-8", className)} {...props} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grow with content up to maxRows. */
  autoGrow?: boolean;
  maxRows?: number;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, autoGrow, maxRows = 14, value, ...props },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current!);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!autoGrow || !el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight + 2, line * maxRows + 16)}px`;
  }, [value, autoGrow, maxRows]);
  return (
    <textarea
      ref={inner}
      value={value}
      className={cn(field, "min-h-16 resize-y py-2 leading-relaxed", autoGrow && "resize-none overflow-y-auto", className)}
      {...props}
    />
  );
});

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1.5 block text-xs font-medium text-fg-muted", className)} {...props} />;
}

export function FieldError({ children }: { children?: string | null }) {
  if (!children) return null;
  return (
    <p role="alert" className="mt-1 text-xs text-danger">
      {children}
    </p>
  );
}
