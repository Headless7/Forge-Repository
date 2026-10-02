"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { studioNameSchema } from "@/lib/validation";
import { errorMessage, rpc } from "@/lib/rpc-client";
import { Button } from "../ui/button";
import { FieldError, Input, Label } from "../ui/input";
import { AuthCard } from "./auth-forms";

export function OnboardingForm({ displayName, existing }: { displayName: string; existing: Array<{ slug: string; name: string }> }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = studioNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter a studio name.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const studio = await rpc("studio.create", { name: parsed.data });
      router.replace(`/${studio.slug}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  return (
    <AuthCard
      title={`Welcome, ${displayName.split(" ")[0]}`}
      subtitle="Create a studio for your team. You can invite people and add projects next."
      footer={
        existing.length ? (
          <>
            Or go to{" "}
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
          "Got an invitation? Open the link from your email to join that studio."
        )
      }
    >
      <form onSubmit={onSubmit} noValidate className="grid gap-3.5">
        <div>
          <Label htmlFor="studio">Studio name</Label>
          <Input id="studio" autoFocus placeholder="e.g. Nightfall Studios" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(error)} />
          <FieldError>{error}</FieldError>
        </div>
        <Button type="submit" variant="primary" size="lg" loading={loading}>
          Create studio
        </Button>
      </form>
    </AuthCard>
  );
}
