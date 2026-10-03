"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signOutEverywhereOnThisDevice } from "@/lib/push-client";
import { errorMessage, rpc } from "@/lib/rpc-client";
import { Button } from "../ui/button";

export function AcceptInvitation({
  token,
  invitedEmail,
  currentEmail,
  emailVerified,
}: {
  token: string;
  invitedEmail: string;
  currentEmail: string;
  emailVerified: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const mismatch = invitedEmail.toLowerCase() !== currentEmail.toLowerCase();

  async function resend() {
    setError(null);
    try {
      // The new link brings them back here once the address is confirmed.
      await rpc("account.resendVerification", { next: `/invite/${token}` });
      setResent(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function accept() {
    setLoading(true);
    setError(null);
    try {
      const { studioSlug } = await rpc("invitation.accept", { token });
      router.replace(`/${studioSlug}`);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  async function switchAccount() {
    await signOutEverywhereOnThisDevice();
    router.replace(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`);
    router.refresh();
  }

  if (mismatch) {
    return (
      <div className="grid gap-3">
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">
          You're signed in as <strong>{currentEmail}</strong>, but this invitation is for <strong>{invitedEmail}</strong>.
        </p>
        <Button variant="secondary" size="lg" onClick={() => void switchAccount()}>
          Sign in with {invitedEmail}
        </Button>
      </div>
    );
  }

  if (!emailVerified) {
    return (
      <div className="grid gap-3">
        <p className="rounded-md border border-info/40 bg-info/10 px-3 py-2 text-[13px]">
          Confirm your email address to join — we sent a link to <strong>{currentEmail}</strong>. It brings you back here.
        </p>
        {error ? (
          <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {error}
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
    );
  }

  return (
    <div className="grid gap-3">
      {error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      <Button variant="primary" size="lg" loading={loading} onClick={() => void accept()}>
        Accept invitation
      </Button>
    </div>
  );
}
