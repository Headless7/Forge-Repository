"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { studioNameSchema } from "@/lib/validation";
import { errorMessage, rpc } from "@/lib/rpc-client";
import { Button } from "../ui/button";
import { FieldError, Input, Label } from "../ui/input";
import { AuthCard } from "./auth-forms";

export interface AccessStatus {
  email: string;
  emailVerified: boolean;
  platformAdmin: boolean;
  canCreateStudio: boolean;
  pendingKey: { hint: string; expiresAt: string } | null;
}

/**
 * Where an account lands without a studio, and where studios are created. Forge is private: the
 * site operator creates studios freely, anyone else needs an activation key, and joining an
 * existing studio happens through an invitation link.
 */
export function OnboardingForm({ displayName, existing, status }: { displayName: string; existing: Array<{ slug: string; name: string }>; status: AccessStatus }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [errors, setErrors] = useState<{ name?: string; key?: string; form?: string }>({});
  const [loading, setLoading] = useState(false);
  const [resent, setResent] = useState(false);
  const needsKey = !status.canCreateStudio;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = studioNameSchema.safeParse(name);
    const next: typeof errors = {};
    if (!parsed.success) next.name = parsed.error.issues[0]?.message ?? "Enter a studio name.";
    if (needsKey && !key.trim()) next.key = "Enter your activation key.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setLoading(true);
    try {
      const studio = await rpc("studio.create", { name: parsed.data!, ...(needsKey ? { activationKey: key.trim() } : {}) });
      router.replace(`/${studio.slug}`);
      router.refresh();
    } catch (err) {
      setErrors({ form: errorMessage(err) });
      setLoading(false);
    }
  }

  async function resend() {
    try {
      await rpc("account.resendVerification", {});
      setResent(true);
    } catch (err) {
      setErrors({ form: errorMessage(err) });
    }
  }

  const footer = (
    <>
      {existing.length ? (
        <>
          Go to{" "}
          {existing.map((s, i) => (
            <span key={s.slug}>
              {i > 0 ? ", " : ""}
              <Link href={`/${s.slug}`} className="font-medium text-accent hover:underline">
                {s.name}
              </Link>
            </span>
          ))}
        </>
      ) : (
        "Got an invitation? Open the link in the email to join that studio."
      )}
      {status.platformAdmin ? (
        <>
          {" · "}
          <Link href="/admin/keys" className="font-medium text-accent hover:underline">
            Activation keys
          </Link>
        </>
      ) : null}
    </>
  );

  if (!status.emailVerified) {
    return (
      <AuthCard title="Confirm your email" subtitle={`We sent a confirmation link to ${status.email}. Open it to continue.`} footer={footer}>
        <div className="grid gap-3">
          {status.pendingKey ? (
            <p className="text-[13px] text-fg-muted">Your activation key is saved to this account — once your email is confirmed you can create your studio here.</p>
          ) : null}
          {errors.form ? (
            <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
              {errors.form}
            </p>
          ) : null}
          {resent ? (
            <p role="status" className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-[13px]">
              A new link is on its way. Check spam too.
            </p>
          ) : (
            <Button variant="secondary" size="lg" onClick={() => void resend()}>
              Send a new confirmation link
            </Button>
          )}
        </div>
      </AuthCard>
    );
  }

  const first = displayName.split(" ")[0];
  const [title, subtitle] = status.platformAdmin
    ? [`Welcome, ${first}`, "Create a studio. You can invite people and add projects next."]
    : status.canCreateStudio
      ? [`Welcome, ${first}`, "Your activation key is ready. Name your studio — you'll be its owner."]
      : existing.length
        ? ["Create a studio", "Creating your own studio needs an activation key from the person who runs this Forge."]
        : [
            "You need an invitation",
            `Forge is private. To join a studio, ask its owner or an admin to invite ${status.email}, then open the link in that email. If you were given an activation key, you can create your own studio below.`,
          ];

  return (
    <AuthCard title={title} subtitle={subtitle} footer={footer}>
      {errors.form ? (
        <p role="alert" className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          {errors.form}
        </p>
      ) : null}
      <form onSubmit={onSubmit} noValidate className="grid gap-3.5">
        {needsKey ? (
          <div>
            <Label htmlFor="key">Activation key</Label>
            <Input
              id="key"
              autoComplete="off"
              spellCheck={false}
              placeholder="FORGE-XXXXX-XXXXX-XXXXX-XXXXX"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              aria-invalid={Boolean(errors.key)}
              className="font-mono"
            />
            <FieldError>{errors.key}</FieldError>
          </div>
        ) : null}
        <div>
          <Label htmlFor="studio">Studio name</Label>
          <Input id="studio" autoFocus={!needsKey} placeholder="e.g. Nightfall Studios" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name)} />
          <FieldError>{errors.name}</FieldError>
        </div>
        <Button type="submit" variant="primary" size="lg" loading={loading}>
          Create studio
        </Button>
      </form>
    </AuthCard>
  );
}
