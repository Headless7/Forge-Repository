"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useRpcMutation } from "@/lib/queries";
import { rpc } from "@/lib/rpc-client";
import { Button } from "../ui/button";
import { Badge, EmptyState, Select, Skeleton } from "../ui/controls";
import { FieldError, Input, Label } from "../ui/input";

const KEYS = ["platform", "keys"] as const;
const STATUS_TONE = { pending: "accent", claimed: "warning", redeemed: "success", expired: "neutral", revoked: "danger" } as const;
const STATUS_LABEL = { pending: "Unused", claimed: "Registered", redeemed: "Studio created", expired: "Expired", revoked: "Revoked" } as const;
const DAY_OPTIONS = [
  { value: "3", label: "3 days" },
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
];

/**
 * The site operator issues one-time activation keys here. A key lets one person create their own
 * studio (as its owner); joining an existing studio goes through that studio's invitations instead.
 */
export function ActivationKeysPage() {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: KEYS, queryFn: () => rpc("platform.keys", {}) });
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [days, setDays] = useState("14");
  const [labelError, setLabelError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ key: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const issue = useRpcMutation("platform.issueKey", {
    onSuccess: (result) => {
      setIssued({ key: result.key, label });
      setCopied(false);
      setLabel("");
      setEmail("");
      void queryClient.invalidateQueries({ queryKey: KEYS });
    },
  });
  const revoke = useRpcMutation("platform.revokeKey", {
    onSuccess: () => {
      toast.success("Key revoked.");
      void queryClient.invalidateQueries({ queryKey: KEYS });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!label.trim()) {
      setLabelError("Say who the key is for.");
      return;
    }
    setLabelError(null);
    issue.mutate({ label: label.trim(), email: email.trim() || null, expiresInDays: Number(days) });
  }

  async function copy(key: string) {
    await navigator.clipboard.writeText(key);
    setCopied(true);
    toast.success("Key copied");
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Activation keys</h1>
          <p className="mt-1 text-[13px] text-fg-muted">
            A key lets one person create their own studio and become its owner. Each key works once, expires, and can be revoked until it&apos;s used. To bring
            someone into an existing studio, invite them from its Members page instead.
          </p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link href="/">Back to Forge</Link>
        </Button>
      </div>

      <section className="rounded-xl border border-border-strong bg-surface-2 p-5">
        <h2 className="text-sm font-semibold">Issue a key</h2>
        <form onSubmit={onSubmit} noValidate className="mt-4 grid gap-3.5 sm:grid-cols-[1fr_1fr_140px]">
          <div>
            <Label htmlFor="label">Who it&apos;s for</Label>
            <Input id="label" placeholder="e.g. Sam — art outsourcing" value={label} onChange={(e) => setLabel(e.target.value)} aria-invalid={Boolean(labelError)} />
            <FieldError>{labelError}</FieldError>
          </div>
          <div>
            <Label htmlFor="email">Only for this email (optional)</Label>
            <Input id="email" type="email" placeholder="sam@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label>Expires after</Label>
            <Select value={days} onValueChange={setDays} options={DAY_OPTIONS} aria-label="Expires after" />
          </div>
          <div className="sm:col-span-3">
            <Button type="submit" variant="primary" loading={issue.isPending}>
              <KeyRound /> Issue key
            </Button>
          </div>
        </form>

        {issued ? (
          <div role="status" className="mt-4 rounded-md border border-success/40 bg-success/10 p-3">
            <p className="text-[13px]">
              Key for <strong>{issued.label}</strong>. Copy it now — it won&apos;t be shown again. They enter it when signing up at{" "}
              <code className="rounded bg-surface-3 px-1">/sign-up</code>.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface-1 px-2.5 py-1.5 font-mono text-[13px] select-all">{issued.key}</code>
              <Button variant="secondary" size="sm" onClick={() => void copy(issued.key)} aria-label="Copy key">
                {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-semibold">Issued keys</h2>
        {keys.isPending ? (
          <Skeleton className="h-24" />
        ) : !keys.data?.length ? (
          <EmptyState icon={<KeyRound />} title="No keys yet" description="Keys you issue appear here with who used them." />
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border-strong bg-surface-2">
            {keys.data.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-[13px]">
                <span className="font-mono text-fg-subtle">…{k.hint}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{k.label}</span>
                <Badge tone={STATUS_TONE[k.status]}>{STATUS_LABEL[k.status]}</Badge>
                <span className="w-full text-[12px] text-fg-subtle sm:w-auto">
                  {k.email ? `For ${k.email}` : "Any email"}
                  {k.claimedBy ? ` · used by ${k.claimedBy}` : ""}
                  {k.studio ? ` · ${k.studio.name}` : ""}
                  {k.status === "pending" || k.status === "claimed" ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : ""}
                </span>
                {k.status === "pending" || k.status === "claimed" ? (
                  <Button variant="ghost" size="xs" loading={revoke.isPending && revoke.variables?.keyId === k.id} onClick={() => revoke.mutate({ keyId: k.id })}>
                    Revoke
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
