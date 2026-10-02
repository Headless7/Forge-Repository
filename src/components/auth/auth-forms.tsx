"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { forgotPasswordSchema, resetPasswordSchema, signInSchema, signUpSchema } from "@/lib/validation";
import { rpc, errorMessage } from "@/lib/rpc-client";
import { cn } from "@/lib/utils";
import { UserAvatar } from "../domain/avatar";
import { Button } from "../ui/button";
import { FieldError, Input, Label } from "../ui/input";

export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children?: ReactNode; footer?: ReactNode }) {
  return (
    <div className="animate-slide-up">
      <div className="rounded-xl border border-border-strong bg-surface-2/95 p-6 shadow-lg backdrop-blur">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-[13px] text-fg-muted">{subtitle}</p> : null}
        {children ? <div className="mt-5">{children}</div> : null}
      </div>
      {footer ? <div className="mt-4 text-center text-[13px] text-fg-muted">{footer}</div> : null}
    </div>
  );
}

async function postAuth(action: string, body: unknown) {
  const res = await fetch(`/api/auth/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { error?: { message: string; details?: { code?: string; issues?: Array<{ path: string; message: string }> } } } | null;
  if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? "Something went wrong. Please try again."), { code: json?.error?.details?.code });
  return json;
}

function safeNext(next: string | null | undefined) {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function issuesToErrors(issues: Array<{ path: PropertyKey[]; message: string }>) {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "form");
    errors[key] ??= issue.message;
  }
  return errors;
}

function Alert({ tone = "danger", children }: { tone?: "danger" | "info" | "success"; children: ReactNode }) {
  const tones = {
    danger: "border-danger/40 bg-danger/10 text-danger",
    info: "border-info/40 bg-info/10 text-fg",
    success: "border-success/40 bg-success/10 text-fg",
  };
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("mb-4 rounded-md border px-3 py-2 text-[13px]", tones[tone])}>
      {children}
    </div>
  );
}

function OAuthButtons({ providers, next }: { providers: { discord: boolean; google: boolean }; next: string }) {
  if (!providers.discord && !providers.google) return null;
  return (
    <>
      <div className="grid gap-2">
        {providers.discord ? (
          <Button variant="secondary" size="lg" asChild>
            <a href={`/api/auth/oauth/discord?next=${encodeURIComponent(next)}`}>
              <svg viewBox="0 0 24 24" className="size-4" fill="#5865F2" aria-hidden>
                <path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.3 18.3 0 0 0-5.6 0L8.6 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.2-.3 13.8.1 18.3a19.9 19.9 0 0 0 6 3l1.3-2a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.8 19.8 0 0 0 6-3c.5-5.2-.9-9.8-3.7-13.9ZM8 15.6c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z" />
              </svg>
              Continue with Discord
            </a>
          </Button>
        ) : null}
        {providers.google ? (
          <Button variant="secondary" size="lg" asChild>
            <a href={`/api/auth/oauth/google?next=${encodeURIComponent(next)}`}>
              <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
                <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7Z" />
                <path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24Z" />
                <path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.7V6.6h-4a12 12 0 0 0 0 10.9l4-3.1Z" />
                <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z" />
              </svg>
              Continue with Google
            </a>
          </Button>
        ) : null}
      </div>
      <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wide text-fg-subtle">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
    </>
  );
}

export interface DemoAccount {
  email: string;
  name: string;
  hint: string;
  color: string;
}

export function SignInForm({
  next,
  error,
  expired,
  providers,
  demo,
}: {
  next?: string;
  error?: string;
  expired?: boolean;
  providers: { discord: boolean; google: boolean };
  demo: { password: string; accounts: DemoAccount[] } | null;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(error ?? null);
  const [loading, setLoading] = useState<string | null>(null);
  // Set when sign-in was refused for an unconfirmed address: offers a fresh confirmation link.
  const [unconfirmed, setUnconfirmed] = useState<{ email: string; resent: boolean } | null>(null);
  const target = safeNext(next);

  async function signIn(credentials: { email: string; password: string }, key: string) {
    const parsed = signInSchema.safeParse(credentials);
    if (!parsed.success) {
      setErrors(issuesToErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setFormError(null);
    setUnconfirmed(null);
    setLoading(key);
    try {
      await postAuth("sign-in", parsed.data);
      router.replace(target);
      router.refresh();
    } catch (e) {
      setFormError(errorMessage(e));
      if ((e as { code?: string }).code === "EMAIL_NOT_VERIFIED") setUnconfirmed({ email: parsed.data.email, resent: false });
      setLoading(null);
    }
  }

  async function resendConfirmation(address: string) {
    setLoading("resend");
    try {
      await postAuth("resend-verification", { email: address });
      setFormError(null);
      setUnconfirmed({ email: address, resent: true });
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setLoading(null);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void signIn({ email, password }, "form");
  }

  return (
    <AuthCard
      title="Sign in"
      subtitle="Welcome back to your studio."
      footer={
        <>
          New here?{" "}
          <Link href={`/sign-up${next ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-medium text-accent hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      {expired ? <Alert tone="info">Your session expired. Sign in again to continue where you left off.</Alert> : null}
      {formError ? <Alert>{formError}</Alert> : null}
      {unconfirmed?.resent ? (
        <Alert tone="success">
          We sent a new confirmation link to <span className="font-medium">{unconfirmed.email}</span>. It can take a minute to arrive — check spam too.
        </Alert>
      ) : unconfirmed ? (
        <Button type="button" variant="secondary" size="lg" className="mb-4 w-full" loading={loading === "resend"} onClick={() => void resendConfirmation(unconfirmed.email)}>
          Send a new confirmation link
        </Button>
      ) : null}
      <OAuthButtons providers={providers} next={target} />
      <form onSubmit={onSubmit} noValidate className="grid gap-3.5">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={Boolean(errors.email)} />
          <FieldError>{errors.email}</FieldError>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link href="/forgot-password" className="mb-1.5 text-xs text-fg-muted hover:text-fg">
              Forgot password?
            </Link>
          </div>
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={Boolean(errors.password)} />
          <FieldError>{errors.password}</FieldError>
        </div>
        <Button type="submit" variant="primary" size="lg" loading={loading === "form"} className="mt-1">
          Sign in
        </Button>
      </form>
      {demo ? (
        <div className="mt-6 border-t border-border pt-4">
          <p className="mb-2 text-xs font-medium text-fg-muted">
            Demo accounts <span className="text-fg-subtle">· password {demo.password}</span>
          </p>
          <div className="grid gap-1">
            {demo.accounts.map((a) => (
              <button
                key={a.email}
                type="button"
                disabled={Boolean(loading)}
                onClick={() => void signIn({ email: a.email, password: demo.password }, a.email)}
                className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-3 disabled:opacity-60"
              >
                <UserAvatar user={{ displayName: a.name, avatarUrl: null, avatarColor: a.color }} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{a.name}</span>
                  <span className="block truncate text-[11px] text-fg-subtle">{a.hint}</span>
                </span>
                {loading === a.email ? <span className="size-3.5 animate-spin rounded-full border-2 border-fg-muted border-t-transparent" /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </AuthCard>
  );
}

export function SignUpForm({
  next,
  invite,
  providers,
}: {
  next?: string;
  invite?: { token: string; email: string; studioName: string } | null;
  providers: { discord: boolean; google: boolean };
}) {
  const router = useRouter();
  const [values, setValues] = useState({ displayName: "", username: "", email: invite?.email ?? "", password: "", activationKey: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = signUpSchema.safeParse({
      ...values,
      username: values.username.trim() ? values.username : undefined,
      inviteToken: invite?.token,
      activationKey: !invite && values.activationKey.trim() ? values.activationKey : undefined,
    });
    if (!parsed.success) {
      setErrors(issuesToErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setFormError(null);
    setLoading(true);
    try {
      await postAuth("sign-up", parsed.data);
      // The invitation (or a new studio) waits until the email address is confirmed.
      router.replace(invite ? `/invite/${invite.token}` : next ? safeNext(next) : "/onboarding");
      router.refresh();
    } catch (err) {
      setFormError(errorMessage(err));
      setLoading(false);
    }
  }

  return (
    <AuthCard
      title={invite ? `Join ${invite.studioName}` : "Create your account"}
      subtitle={
        invite
          ? `You were invited as ${invite.email}.`
          : "Forge is invitation-only. Use the link in your invitation email, or enter the activation key you were given."
      }
      footer={
        <>
          Already have an account?{" "}
          <Link href={`/sign-in${next ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      {formError ? <Alert>{formError}</Alert> : null}
      {!invite ? <OAuthButtons providers={providers} next={next ?? "/onboarding"} /> : null}
      <form onSubmit={onSubmit} noValidate className="grid gap-3.5">
        <div className="grid gap-3.5 sm:grid-cols-2">
          <div>
            <Label htmlFor="displayName">Name</Label>
            <Input id="displayName" autoComplete="name" autoFocus value={values.displayName} onChange={set("displayName")} aria-invalid={Boolean(errors.displayName)} />
            <FieldError>{errors.displayName}</FieldError>
          </div>
          <div>
            <Label htmlFor="username">Username</Label>
            <Input id="username" autoComplete="username" placeholder="optional" value={values.username} onChange={set("username")} aria-invalid={Boolean(errors.username)} />
            <FieldError>{errors.username}</FieldError>
          </div>
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" value={values.email} onChange={set("email")} readOnly={Boolean(invite)} aria-invalid={Boolean(errors.email)} />
          <FieldError>{errors.email}</FieldError>
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="new-password" value={values.password} onChange={set("password")} aria-invalid={Boolean(errors.password)} />
          <FieldError>{errors.password ?? null}</FieldError>
          {!errors.password ? <p className="mt-1 text-[11px] text-fg-subtle">At least 8 characters.</p> : null}
        </div>
        {!invite ? (
          <div>
            <Label htmlFor="activationKey">Activation key</Label>
            <Input
              id="activationKey"
              autoComplete="off"
              spellCheck={false}
              placeholder="FORGE-XXXXX-XXXXX-XXXXX-XXXXX"
              value={values.activationKey}
              onChange={set("activationKey")}
              aria-invalid={Boolean(errors.activationKey)}
              className="font-mono"
            />
            <FieldError>{errors.activationKey}</FieldError>
          </div>
        ) : null}
        <Button type="submit" variant="primary" size="lg" loading={loading} className="mt-1">
          {invite ? "Create account & join" : "Create account"}
        </Button>
      </form>
    </AuthCard>
  );
}

export function ForgotPasswordForm({ devOutbox }: { devOutbox: boolean }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = forgotPasswordSchema.safeParse({ email });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter a valid email.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await postAuth("forgot-password", parsed.data);
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard
      title="Reset your password"
      subtitle="We'll email you a link to choose a new password."
      footer={
        <Link href="/sign-in" className="font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <Alert tone="success">
          If an account exists for <strong>{email}</strong>, a reset link is on its way. It expires in 1 hour.
          {devOutbox ? (
            <>
              {" "}
              Open the dev outbox with the link <code>npm run dev</code> printed in its terminal.
            </>
          ) : null}
        </Alert>
      ) : (
        <form onSubmit={onSubmit} noValidate className="grid gap-3.5">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={Boolean(error)} />
            <FieldError>{error}</FieldError>
          </div>
          <Button type="submit" variant="primary" size="lg" loading={loading}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthCard>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    const parsed = resetPasswordSchema.safeParse({ token, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid password.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await postAuth("reset-password", parsed.data);
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setLoading(false);
    }
  }

  return (
    <AuthCard title="Choose a new password" subtitle="You'll be signed out everywhere else.">
      {error ? <Alert>{error}</Alert> : null}
      <form onSubmit={onSubmit} noValidate className="grid gap-3.5">
        <div>
          <Label htmlFor="password">New password</Label>
          <Input id="password" type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="confirm">Confirm password</Label>
          <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <Button type="submit" variant="primary" size="lg" loading={loading}>
          Update password
        </Button>
      </form>
    </AuthCard>
  );
}

/** `next`: where to continue once confirmed (e.g. the invitation the account was created from). */
export function VerifyEmail({ token, next }: { token: string | null; next?: string | null }) {
  const [state, setState] = useState<"working" | "done" | "error">(token ? "working" : "error");
  const [message, setMessage] = useState<string>(token ? "" : "This link is missing its token.");
  useEffect(() => {
    if (!token) return;
    postAuth("verify-email", { token })
      .then(() => setState("done"))
      .catch((err) => {
        setState("error");
        setMessage(errorMessage(err));
      });
  }, [token]);
  return (
    <AuthCard title="Confirm your email">
      {state === "working" ? <p className="text-[13px] text-fg-muted">Confirming…</p> : null}
      {state === "done" ? <Alert tone="success">Your email is confirmed. You're all set.</Alert> : null}
      {state === "error" ? <Alert>{message}</Alert> : null}
      <Button asChild variant="primary" size="lg" className="w-full">
        <Link href={safeNext(next)}>{next?.startsWith("/invite/") ? "Continue to your invitation" : "Continue to Forge"}</Link>
      </Button>
    </AuthCard>
  );
}
