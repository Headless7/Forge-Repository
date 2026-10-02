"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ROBLOX_TEMPLATE } from "@/lib/column-icons";
import { qk, useRpcMutation } from "@/lib/queries";
import { projectKeyFrom } from "@/lib/slugs";
import { projectNameSchema } from "@/lib/validation";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog";
import { FieldError, Input, Label } from "../ui/input";

export const PROJECT_EMOJIS = ["🎮", "🗼", "🏴‍☠️", "🧪", "⚔️", "🐉", "🏰", "🚀", "🌋", "🧟", "🎃", "🏎️", "🧙", "🥷", "🌌", "🏝️", "⚽", "👾", "🌙", "🔥", "💎", "🛡️", "🎯", "🌀"];

export function CreateProjectDialog({ open, onOpenChange, studio }: { open: boolean; onOpenChange: (open: boolean) => void; studio: { id: string; slug: string } }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [icon, setIcon] = useState("🎮");
  const [template, setTemplate] = useState<"roblox" | "empty">("roblox");
  const [visibility, setVisibility] = useState<"STUDIO" | "PRIVATE">("STUDIO");
  const [error, setError] = useState<string | null>(null);

  const create = useRpcMutation("project.create", {
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: qk.projects(studio.id) });
      void queryClient.invalidateQueries({ queryKey: qk.home(studio.id) });
      onOpenChange(false);
      setName("");
      setKey("");
      setKeyEdited(false);
      router.push(`/${studio.slug}/${project.slug}`);
      router.refresh();
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = projectNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter a name.");
      return;
    }
    setError(null);
    create.mutate({ studioId: studio.id, name: parsed.data, key: key || undefined, icon, template, visibility });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New project" description="Projects get their own board, members and milestones." size="md">
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <div>
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                autoFocus
                placeholder="Universal Tower Defense"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!keyEdited) setKey(e.target.value.trim() ? projectKeyFrom(e.target.value) : "");
                }}
                aria-invalid={Boolean(error)}
              />
              <FieldError>{error}</FieldError>
            </div>
            <div>
              <Label htmlFor="project-key">Card key</Label>
              <Input
                id="project-key"
                value={key}
                maxLength={5}
                onChange={(e) => {
                  setKeyEdited(true);
                  setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
                }}
                className="font-mono uppercase"
              />
            </div>
          </div>
          <div>
            <Label>Icon</Label>
            <div className="flex flex-wrap gap-1">
              {PROJECT_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setIcon(emoji)}
                  aria-label={`Use ${emoji}`}
                  aria-pressed={icon === emoji}
                  className={cn("flex size-8 items-center justify-center rounded-md text-base transition-colors hover:bg-surface-4", icon === emoji && "bg-accent-soft ring-1 ring-accent")}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label>Board template</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  ["roblox", "Roblox game", ROBLOX_TEMPLATE.map((c) => c.name).join(" · ")],
                  ["empty", "Blank board", "Start without categories"],
                ] as const
              ).map(([value, title, desc]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTemplate(value)}
                  aria-pressed={template === value}
                  className={cn(
                    "rounded-lg border p-3 text-left transition-colors",
                    template === value ? "border-accent bg-accent-soft" : "border-border-strong hover:bg-surface-3",
                  )}
                >
                  <span className="block text-[13px] font-medium">{title}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-fg-muted">{desc}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label>Visibility</Label>
            <div className="flex gap-2">
              {(
                [
                  ["STUDIO", "Everyone in the studio"],
                  ["PRIVATE", "Only project members"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setVisibility(value)}
                  aria-pressed={visibility === value}
                  className={cn("h-8 rounded-md border px-3 text-[13px]", visibility === value ? "border-accent bg-accent-soft text-fg" : "border-border-strong text-fg-muted hover:bg-surface-3")}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
