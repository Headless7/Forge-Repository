"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Kbd } from "../ui/controls";

/**
 * Trello-speed card creation: type a title, press Enter, keep going.
 * Ctrl/Cmd+Enter creates the card and opens it.
 */
export function QuickAdd({ onCreate, onClose }: { onCreate: (title: string, open: boolean) => void; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const submit = (open: boolean) => {
    const value = title.trim();
    if (!value) return;
    onCreate(value, open);
    setTitle("");
    ref.current?.focus();
  };

  return (
    <div className="rounded-lg border border-accent/60 bg-surface-2 p-2 shadow-md animate-slide-up" onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={title}
        rows={2}
        maxLength={200}
        placeholder="Card title…"
        aria-label="New card title"
        onChange={(e) => setTitle(e.target.value.replace(/\n/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit(e.ctrlKey || e.metaKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        onBlur={() => {
          if (!title.trim()) onClose();
        }}
        className="w-full resize-none bg-transparent text-[13px] leading-snug outline-none placeholder:text-fg-subtle"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <Button size="xs" variant="primary" onMouseDown={(e) => e.preventDefault()} onClick={() => submit(false)} disabled={!title.trim()}>
          Add card
        </Button>
        <Button size="xs" variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={onClose}>
          Cancel
        </Button>
        <span className="ml-auto hidden items-center gap-1 text-[10.5px] text-fg-subtle sm:flex">
          <Kbd>Enter</Kbd> add · <Kbd>Ctrl</Kbd>
          <Kbd>Enter</Kbd> add & open
        </span>
      </div>
    </div>
  );
}
