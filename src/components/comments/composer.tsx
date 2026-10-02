"use client";

import { AtSign, Bold, Code, Italic, Link2, Paperclip, Send, X, File as FileIcon } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { AttachmentDTO, MemberDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { UserAvatar } from "../domain/avatar";
import { Button } from "../ui/button";
import { Kbd } from "../ui/controls";
import { Tooltip } from "../ui/menu";
import { useUploads, type UploadTarget } from "../upload/upload-manager";

export interface ComposerSubmit {
  body: string;
  attachmentIds: string[];
}

interface Pending {
  id: string;
  file: File;
  preview: string | null;
  attachment?: AttachmentDTO;
  failed?: boolean;
}

function mentionQuery(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(^|[\s(])@([a-zA-Z0-9_]{0,24})$/.exec(before);
  if (!match) return null;
  return { start: caret - match[2]!.length - 1, query: match[2]!.toLowerCase() };
}

export function Composer({
  members,
  onSubmit,
  placeholder = "Write a comment…",
  submitLabel = "Comment",
  card,
  autoFocus,
  compact,
  header,
  onFocus,
  initialValue = "",
  onCancel,
  disabled,
}: {
  members: MemberDTO[];
  onSubmit: (value: ComposerSubmit) => Promise<unknown>;
  placeholder?: string;
  submitLabel?: string;
  /** When provided, files can be attached (uploaded as comment attachments). */
  card?: UploadTarget;
  autoFocus?: boolean;
  compact?: boolean;
  header?: ReactNode;
  onFocus?: () => void;
  initialValue?: string;
  onCancel?: () => void;
  disabled?: boolean;
}) {
  const uploads = useUploads();
  const [value, setValue] = useState(initialValue);
  const [pending, setPending] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(() => {
    if (!mention) return [];
    return members
      .filter((m) => m.username.startsWith(mention.query) || m.displayName.toLowerCase().includes(mention.query))
      .slice(0, 6);
  }, [members, mention]);

  const uploading = pending.some((p) => !p.attachment && !p.failed);
  const canSend = (value.trim().length > 0 || pending.some((p) => p.attachment)) && !uploading && !sending && !disabled;

  const syncMention = (next: string, caret: number) => {
    const q = mentionQuery(next, caret);
    setMention(q);
    setMentionIndex(0);
  };

  const insertMention = (member: MemberDTO) => {
    if (!mention || !textarea.current) return;
    const caret = textarea.current.selectionStart;
    const next = `${value.slice(0, mention.start)}@${member.username} ${value.slice(caret)}`;
    setValue(next);
    setMention(null);
    const pos = mention.start + member.username.length + 2;
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(pos, pos);
    });
  };

  const wrap = (before: string, after = before, placeholderText = "text") => {
    const el = textarea.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const selected = value.slice(s, e) || placeholderText;
    const next = value.slice(0, s) + before + selected + after + value.slice(e);
    setValue(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + before.length, s + before.length + selected.length);
    });
  };

  const addFiles = (files: File[]) => {
    if (!card || files.length === 0) return;
    const items: Pending[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    }));
    setPending((list) => [...list, ...items]);
    for (const item of items) {
      void uploads
        .uploadFiles(card, [item.file], "comment")
        .then(([attachment]) => {
          setPending((list) => list.map((p) => (p.id === item.id ? (attachment ? { ...p, attachment } : { ...p, failed: true }) : p)));
        })
        .catch(() => setPending((list) => list.map((p) => (p.id === item.id ? { ...p, failed: true } : p))));
    }
  };

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      await onSubmit({ body: value.trim(), attachmentIds: pending.flatMap((p) => (p.attachment ? [p.attachment.id] : [])) });
      setValue("");
      pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
      setPending([]);
    } catch {
      // The mutation already surfaced the error; keep the draft.
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={cn("@container relative rounded-lg border border-border-strong bg-surface-3/50 transition-colors focus-within:border-accent/70", disabled && "opacity-60")}>
      {header ? <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2">{header}</div> : null}
      <textarea
        ref={textarea}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        rows={compact ? 1 : 2}
        placeholder={placeholder}
        aria-label={placeholder}
        onFocus={onFocus}
        onChange={(e) => {
          setValue(e.target.value);
          syncMention(e.target.value, e.target.selectionStart);
        }}
        onKeyUp={(e) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) syncMention(value, e.currentTarget.selectionStart);
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          if (files.length && card) {
            e.preventDefault();
            addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (mention && suggestions.length) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setMentionIndex((i) => (i + 1) % suggestions.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setMentionIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              insertMention(suggestions[mentionIndex]!);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMention(null);
              return;
            }
          }
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            onCancel();
          }
        }}
        style={{ fieldSizing: "content" } as React.CSSProperties}
        className={cn("block max-h-60 w-full resize-none bg-transparent px-2.5 py-2 text-[13px] leading-relaxed outline-none", compact ? "min-h-9" : "min-h-16")}
      />
      {mention && suggestions.length ? (
        <ul role="listbox" aria-label="Mention someone" className="absolute bottom-full left-2 z-20 mb-1 w-64 overflow-hidden rounded-lg border border-border-strong bg-surface-2 p-1 shadow-lg">
          {suggestions.map((m, i) => (
            <li
              key={m.id}
              role="option"
              aria-selected={i === mentionIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(m);
              }}
              className={cn("flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px]", i === mentionIndex && "bg-surface-4")}
            >
              <UserAvatar user={m} size="xs" online={m.online} />
              <span className="truncate font-medium">{m.displayName}</span>
              <span className="truncate text-fg-subtle">@{m.username}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {pending.length ? (
        <div className="flex flex-wrap gap-2 px-2.5 pb-1">
          {pending.map((p) => (
            <div key={p.id} className="relative flex h-14 items-center gap-2 overflow-hidden rounded-md border border-border-strong bg-surface-2 pr-6">
              {p.preview ? <img src={p.preview} alt="" className="h-full w-16 object-cover" /> : <FileIcon className="ml-2 size-4 text-fg-subtle" />}
              <span className="max-w-32 truncate text-[11px]">{p.failed ? "Upload failed" : p.attachment ? p.file.name : "Uploading…"}</span>
              <button
                type="button"
                aria-label="Remove attachment"
                onClick={() => setPending((list) => list.filter((x) => x.id !== p.id))}
                className="absolute right-1 top-1 rounded bg-surface-4 p-0.5 text-fg-muted hover:text-fg"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
        <Tooltip content="Bold">
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Bold" onClick={() => wrap("**")}>
            <Bold />
          </Button>
        </Tooltip>
        <Tooltip content="Italic">
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Italic" onClick={() => wrap("*")}>
            <Italic />
          </Button>
        </Tooltip>
        <Tooltip content="Code">
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Code" onClick={() => wrap("`", "`", "code")}>
            <Code />
          </Button>
        </Tooltip>
        <Tooltip content="Link">
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Link" onClick={() => wrap("[", "](https://)", "label")}>
            <Link2 />
          </Button>
        </Tooltip>
        <Tooltip content="Mention">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Mention someone"
            onClick={() => {
              const el = textarea.current;
              if (!el) return;
              const pos = el.selectionStart;
              const needsSpace = pos > 0 && !/\s/.test(value[pos - 1] ?? "");
              const next = `${value.slice(0, pos)}${needsSpace ? " " : ""}@${value.slice(pos)}`;
              setValue(next);
              const caret = pos + (needsSpace ? 2 : 1);
              setMention({ start: caret - 1, query: "" });
              requestAnimationFrame(() => {
                el.focus();
                el.setSelectionRange(caret, caret);
              });
            }}
          >
            <AtSign />
          </Button>
        </Tooltip>
        {card ? (
          <>
            <Tooltip content="Attach files">
              <Button type="button" size="icon-xs" variant="ghost" aria-label="Attach files" onClick={() => fileInput.current?.click()}>
                <Paperclip />
              </Button>
            </Tooltip>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </>
        ) : null}
        <span className="flex-1" />
        <span className="mr-1.5 hidden items-center gap-1 text-[10.5px] text-fg-subtle @sm:flex">
          <Kbd>Ctrl</Kbd>
          <Kbd>Enter</Kbd>
        </span>
        {onCancel ? (
          <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="button" size="xs" variant="primary" disabled={!canSend} loading={sending} onClick={() => void submit()}>
          <Send /> {submitLabel}
        </Button>
      </div>
    </div>
  );
}
