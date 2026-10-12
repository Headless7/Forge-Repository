"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FORUM_ICONS, keyPrefixFrom } from "@/lib/forum-meta";
import { qk, useRpcMutation } from "@/lib/queries";
import type { ForumDTO, MemberDTO } from "@/lib/types";
import { cn } from "@/lib/utils";
import { UserAvatar } from "../domain/avatar";
import { Button } from "../ui/button";
import { Select } from "../ui/controls";
import { ConfirmDialog, Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { Input, Label, Textarea } from "../ui/input";

function IconPicker({ value, onChange }: { value: string; onChange: (icon: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Icon" className="flex flex-wrap gap-1">
      {FORUM_ICONS.map((icon) => (
        <button
          key={icon}
          type="button"
          role="radio"
          aria-checked={value === icon}
          aria-label={icon}
          onClick={() => onChange(icon)}
          className={cn("touch-target flex size-8 items-center justify-center rounded-md border text-[16px]", value === icon ? "border-accent bg-accent-soft" : "border-border-strong hover:bg-surface-3")}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}

function ReviewerSelect({ value, members, onChange, disabled }: { value: string | null; members: MemberDTO[]; onChange: (id: string | null) => void; disabled?: boolean }) {
  return (
    <Select<string>
      aria-label="Default reviewer"
      disabled={disabled}
      value={value ?? ""}
      onValueChange={(v) => onChange(v || null)}
      options={[{ value: "", label: "Nobody (any manager)" }, ...members.map((m) => ({ value: m.id, label: m.displayName, icon: <UserAvatar user={m} size="xs" /> }))]}
    />
  );
}

/** Make a custom forum: a tracker for whatever the standard Bugs and QA don't cover (a playtest, an update's polish list). */
export function NewForumDialog({ open, onOpenChange, projectId, studioSlug, projectSlug, members }: { open: boolean; onOpenChange: (open: boolean) => void; projectId: string; studioSlug: string; projectSlug: string; members: MemberDTO[] }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState("📋");
  const [itemLabel, setItemLabel] = useState("issue");
  const [prefix, setPrefix] = useState("");
  const [prefixTouched, setPrefixTouched] = useState(false);
  const [reviewerId, setReviewerId] = useState<string | null>(null);
  useEffect(() => {
    if (!prefixTouched) setPrefix(name.trim() ? keyPrefixFrom(name) : "");
  }, [name, prefixTouched]);
  const create = useRpcMutation("forum.create", {
    onSuccess: (forum) => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      void queryClient.invalidateQueries({ queryKey: qk.forums(projectId) });
      toast.success(`${forum.icon} ${forum.name} created.`);
      onOpenChange(false);
      setName("");
      setDescription("");
      setPrefixTouched(false);
      router.push(`/${studioSlug}/${projectSlug}/f/${forum.slug}`);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New forum" description="A tracker beside the boards, like Bugs and QA: items with a priority, tags, someone to do them and someone to verify, grouped by update.">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate({ projectId, name: name.trim(), description: description.trim() || undefined, icon, keyPrefix: prefix || undefined, itemLabel: itemLabel.trim() || undefined, defaultReviewerId: reviewerId });
          }}
        >
          <div>
            <Label htmlFor="forum-name">Name</Label>
            <Input id="forum-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Update 6.5 playtest" maxLength={40} required />
          </div>
          <div>
            <Label htmlFor="forum-description">What goes here</Label>
            <Textarea id="forum-description" autoGrow maxRows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Shown at the top of the forum." className="min-h-14" maxLength={500} />
          </div>
          <div>
            <Label>Icon</Label>
            <IconPicker value={icon} onChange={setIcon} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="forum-noun">One item is called a…</Label>
              <Input id="forum-noun" value={itemLabel} onChange={(e) => setItemLabel(e.target.value)} placeholder="issue" maxLength={20} />
              <p className="mt-1 text-[11.5px] text-fg-subtle">Used in buttons and notifications: &quot;Log an issue&quot;.</p>
            </div>
            <div>
              <Label htmlFor="forum-prefix">Key prefix</Label>
              <Input
                id="forum-prefix"
                value={prefix}
                onChange={(e) => {
                  setPrefixTouched(true);
                  setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3));
                }}
                placeholder="PT"
                maxLength={3}
                className="font-mono"
              />
              <p className="mt-1 text-[11.5px] text-fg-subtle">Items are numbered KEY-{prefix || "XX"}1, KEY-{prefix || "XX"}2…</p>
            </div>
          </div>
          <div>
            <Label>Default reviewer</Label>
            <ReviewerSelect value={reviewerId} members={members} onChange={setReviewerId} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim()} loading={create.isPending}>
              Create forum
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Rename, describe, re-icon a forum, change its noun, prefix and default reviewer; archive custom ones. */
export function ForumSettingsDialog({ open, onOpenChange, forum, members, studioSlug, projectSlug }: { open: boolean; onOpenChange: (open: boolean) => void; forum: ForumDTO; members: MemberDTO[]; studioSlug: string; projectSlug: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState(forum.name);
  const [description, setDescription] = useState(forum.description);
  const [icon, setIcon] = useState(forum.icon);
  const [itemLabel, setItemLabel] = useState(forum.itemLabel);
  const [prefix, setPrefix] = useState(forum.keyPrefix);
  const [reviewerId, setReviewerId] = useState<string | null>(forum.settings.defaultReviewerId);
  const [confirmArchive, setConfirmArchive] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(forum.name);
    setDescription(forum.description);
    setIcon(forum.icon);
    setItemLabel(forum.itemLabel);
    setPrefix(forum.keyPrefix);
    setReviewerId(forum.settings.defaultReviewerId);
  }, [open, forum]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    void queryClient.invalidateQueries({ queryKey: qk.forums(forum.projectId) });
  };
  const update = useRpcMutation("forum.update", {
    onSuccess: (updated) => {
      refresh();
      toast.success("Saved.");
      onOpenChange(false);
      if (updated.slug !== forum.slug) router.replace(`/${studioSlug}/${projectSlug}/f/${updated.slug}`);
    },
  });
  const archive = useRpcMutation("forum.update", {
    onSuccess: () => {
      refresh();
      toast.success(`${forum.name} archived. Restore it from project settings.`);
      router.push(`/${studioSlug}/${projectSlug}/f/bugs`);
    },
  });
  const standard = forum.kind !== "CUSTOM";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`${forum.icon} ${forum.name} settings`} description={standard ? "Bugs and QA come with every project; you can still rename them and change their wording." : undefined}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ forumId: forum.id, name: name.trim() || forum.name, description, icon, itemLabel: itemLabel.trim() || forum.itemLabel, keyPrefix: prefix || forum.keyPrefix, defaultReviewerId: reviewerId });
          }}
        >
          <div>
            <Label htmlFor="forum-s-name">Name</Label>
            <Input id="forum-s-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
          </div>
          <div>
            <Label htmlFor="forum-s-description">What goes here</Label>
            <Textarea id="forum-s-description" autoGrow maxRows={4} value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-14" maxLength={500} />
          </div>
          <div>
            <Label>Icon</Label>
            <IconPicker value={icon} onChange={setIcon} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="forum-s-noun">One item is called a…</Label>
              <Input id="forum-s-noun" value={itemLabel} onChange={(e) => setItemLabel(e.target.value)} maxLength={20} />
            </div>
            <div>
              <Label htmlFor="forum-s-prefix">Key prefix</Label>
              <Input id="forum-s-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3))} maxLength={3} className="font-mono" />
              <p className="mt-1 text-[11.5px] text-fg-subtle">Changing it renames every item&apos;s key.</p>
            </div>
          </div>
          <div>
            <Label>Default reviewer</Label>
            <ReviewerSelect value={reviewerId} members={members} onChange={setReviewerId} />
            <p className="mt-1 text-[11.5px] text-fg-subtle">Verifies every new {itemLabel || "item"} unless the reporter picks someone else — the lead scripter, typically.</p>
          </div>
          <DialogFooter className={cn(!standard && "justify-between")}>
            {!standard ? (
              <Button type="button" variant="danger-ghost" onClick={() => setConfirmArchive(true)}>
                Archive forum
              </Button>
            ) : null}
            <span className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={update.isPending}>
                Save
              </Button>
            </span>
          </DialogFooter>
        </form>
      </DialogContent>
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`Archive ${forum.name}?`}
        description="It disappears from the sidebar and becomes read-only. Its items stay, and it can be restored from project settings."
        confirmLabel="Archive"
        loading={archive.isPending}
        onConfirm={() => archive.mutate({ forumId: forum.id, archived: true })}
      />
    </Dialog>
  );
}
