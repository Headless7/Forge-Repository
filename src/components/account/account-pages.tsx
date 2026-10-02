"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Laptop, LogOut, MailCheck, MailWarning, Monitor, Moon, Smartphone, Sun, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { NOTIFICATION_TYPE_META } from "@/lib/notifications";
import { qk, useRpcMutation } from "@/lib/queries";
import { errorMessage, rpc, type RpcOutput } from "@/lib/rpc-client";
import { cn, formatDateTime, timeAgo } from "@/lib/utils";
import { displayNameSchema, emailSchema, passwordSchema, usernameSchema } from "@/lib/validation";
import { UserAvatar } from "../domain/avatar";
import { Button } from "../ui/button";
import { Skeleton, Switch } from "../ui/controls";
import { FieldError, Input, Label } from "../ui/input";

type Profile = RpcOutput<"account.profile">;

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface-2 p-5">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {description ? <p className="mt-0.5 text-[12.5px] text-fg-muted">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function useProfile(initial: Profile) {
  return useQuery({ queryKey: qk.profile(), queryFn: () => rpc("account.profile", {}), initialData: initial });
}

export function ProfilePage({ initial }: { initial: Profile }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: profile } = useProfile(initial);
  const [name, setName] = useState(profile.displayName);
  const [username, setUsername] = useState(profile.username);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [email, setEmail] = useState(profile.email);
  const [password, setPassword] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const setProfile = (p: Profile) => {
    queryClient.setQueryData(qk.profile(), p);
    router.refresh();
  };
  const update = useRpcMutation("account.update", { onSuccess: (p) => { setProfile(p); toast.success("Profile updated."); } });
  const changeEmail = useRpcMutation("account.changeEmail", { onSuccess: (p) => { setProfile(p); setPassword(""); toast.success("Check your inbox to confirm the new address."); } });
  const removeAvatar = useRpcMutation("account.removeAvatar", { onSuccess: setProfile });
  const resend = useRpcMutation("account.resendVerification", { onSuccess: (r) => toast.success(r.alreadyVerified ? "Your email is already confirmed." : "Confirmation email sent.") });

  const saveProfile = () => {
    const next: Record<string, string> = {};
    const n = displayNameSchema.safeParse(name);
    const u = usernameSchema.safeParse(username);
    if (!n.success) next.name = n.error.issues[0]!.message;
    if (!u.success) next.username = u.error.issues[0]!.message;
    setErrors(next);
    if (Object.keys(next).length) return;
    update.mutate({ displayName: n.data, username: u.data });
  };

  const uploadAvatar = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch("/api/account/avatar", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? "Upload failed.");
      setProfile(json.data);
      toast.success("Avatar updated.");
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="grid gap-5">
      <Card title="Profile" description="How teammates see you across Forge.">
        <div className="flex flex-wrap items-center gap-4">
          <UserAvatar user={profile} size="xl" />
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" loading={uploading} onClick={() => fileInput.current?.click()}>
              <Camera /> Upload avatar
            </Button>
            {profile.avatarUrl ? (
              <Button variant="ghost" size="sm" onClick={() => removeAvatar.mutate({})}>
                <Trash2 /> Remove
              </Button>
            ) : null}
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadAvatar(f); e.target.value = ""; }} />
          </div>
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="display-name">Display name</Label>
            <Input id="display-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name)} />
            <FieldError>{errors.name}</FieldError>
          </div>
          <div>
            <Label htmlFor="username">Username</Label>
            <Input id="username" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} aria-invalid={Boolean(errors.username)} />
            <FieldError>{errors.username}</FieldError>
            {!errors.username ? <p className="mt-1 text-[11px] text-fg-subtle">Used for @mentions.</p> : null}
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="primary" loading={update.isPending} disabled={name === profile.displayName && username === profile.username} onClick={saveProfile}>
            Save profile
          </Button>
        </div>
      </Card>

      <Card title="Email">
        <div className="mb-3 flex items-center gap-2 text-[13px]">
          {profile.emailVerified ? (
            <span className="inline-flex items-center gap-1.5 text-state-approved">
              <MailCheck className="size-4" /> {profile.email} is confirmed
            </span>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5 text-warning">
                <MailWarning className="size-4" /> {profile.email} isn&apos;t confirmed yet
              </span>
              <Button size="xs" variant="ghost" loading={resend.isPending} onClick={() => resend.mutate({})}>
                Resend link
              </Button>
            </>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="new-email">Email address</Label>
            <Input id="new-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          {profile.hasPassword ? (
            <div>
              <Label htmlFor="email-password">Current password</Label>
              <Input id="email-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          ) : null}
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            variant="secondary"
            loading={changeEmail.isPending}
            disabled={email.trim().toLowerCase() === profile.email}
            onClick={() => {
              const parsed = emailSchema.safeParse(email.trim());
              if (!parsed.success) return toast.error("Enter a valid email address.");
              changeEmail.mutate({ email: parsed.data, password: password || undefined });
            }}
          >
            Change email
          </Button>
        </div>
      </Card>

      <Card title="Appearance">
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ["dark", "Dark", Moon],
              ["light", "Light", Sun],
              ["system", "System", Monitor],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                const resolved = value === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : value;
                document.documentElement.dataset.theme = resolved;
                update.mutate({ theme: value });
              }}
              aria-pressed={profile.theme === value}
              className={cn("flex h-16 flex-col items-center justify-center gap-1 rounded-lg border text-[13px]", profile.theme === value ? "border-accent bg-accent-soft" : "border-border-strong hover:bg-surface-3")}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function NotificationPreferencesPage() {
  const queryClient = useQueryClient();
  const prefs = useQuery({ queryKey: qk.notificationPrefs(), queryFn: () => rpc("notification.preferences", {}) });
  const set = useRpcMutation("notification.setPreference", { onSuccess: (data) => queryClient.setQueryData(qk.notificationPrefs(), data) });
  return (
    <div className="grid gap-5">
      <Card title="In-app notifications" description="Choose what shows up in your notification center. Discord and email delivery can be connected later.">
        {prefs.isLoading ? (
          <div className="grid gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {(prefs.data ?? []).map((p) => (
              <li key={p.type} className="flex items-center justify-between gap-4 py-3">
                <span>
                  <span className="block text-[13px] font-medium">{NOTIFICATION_TYPE_META[p.type].label}</span>
                  <span className="block text-[12px] text-fg-muted">{NOTIFICATION_TYPE_META[p.type].description}</span>
                </span>
                <Switch checked={p.inApp} onCheckedChange={(v) => set.mutate({ type: p.type, inApp: v })} aria-label={NOTIFICATION_TYPE_META[p.type].label} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function deviceIcon(ua: string | null) {
  if (!ua) return <Laptop className="size-4" />;
  return /mobile|iphone|android/i.test(ua) ? <Smartphone className="size-4" /> : <Laptop className="size-4" />;
}

function describeAgent(ua: string | null) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return `${browser}${os ? ` on ${os}` : ""}`;
}

export function SecurityPage({ initial }: { initial: Profile }) {
  const queryClient = useQueryClient();
  const { data: profile } = useProfile(initial);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sessions = useQuery({ queryKey: qk.sessions(), queryFn: () => rpc("account.sessions", {}) });
  const change = useRpcMutation("account.changePassword", {
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      void queryClient.invalidateQueries({ queryKey: qk.sessions() });
      toast.success("Password changed. Other devices were signed out.");
    },
  });
  const revoke = useRpcMutation("account.revokeSession", { onSuccess: (list) => queryClient.setQueryData(qk.sessions(), list) });

  const submit = () => {
    if (next !== confirm) return setError("Passwords don't match.");
    const parsed = passwordSchema.safeParse(next);
    if (!parsed.success) return setError(parsed.error.issues[0]!.message);
    setError(null);
    change.mutate({ currentPassword: current || undefined, newPassword: next });
  };

  return (
    <div className="grid gap-5">
      <Card title={profile.hasPassword ? "Change password" : "Set a password"} description={profile.hasPassword ? "Changing your password signs you out everywhere else." : "You sign in with a connected account. Add a password to also sign in with email."}>
        <div className="grid gap-3 sm:max-w-sm">
          {profile.hasPassword ? (
            <div>
              <Label htmlFor="current-password">Current password</Label>
              <Input id="current-password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </div>
          ) : null}
          <div>
            <Label htmlFor="new-password">New password</Label>
            <Input id="new-password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input id="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <FieldError>{error}</FieldError>
          </div>
          <div>
            <Button variant="primary" loading={change.isPending} disabled={!next} onClick={submit}>
              Update password
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Active sessions" description="Devices currently signed in to your account.">
        {sessions.isLoading ? (
          <Skeleton className="h-24" />
        ) : (
          <>
            <ul className="divide-y divide-border">
              {(sessions.data ?? []).map((s) => (
                <li key={s.id} className="flex items-center gap-3 py-2.5">
                  <span className="text-fg-muted">{deviceIcon(s.userAgent)}</span>
                  <div className="min-w-0 flex-1 text-[13px]">
                    <p className="font-medium">
                      {describeAgent(s.userAgent)} {s.current ? <span className="ml-1 rounded bg-state-approved/15 px-1.5 text-[11px] font-semibold text-state-approved">This device</span> : null}
                    </p>
                    <p className="text-[11.5px] text-fg-subtle">
                      {s.ipAddress ?? "unknown IP"} · signed in {formatDateTime(s.createdAt)} · active {timeAgo(s.lastActiveAt)}
                    </p>
                  </div>
                  {!s.current ? (
                    <Button size="xs" variant="ghost" onClick={() => revoke.mutate({ sessionId: s.id })}>
                      <LogOut /> Sign out
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {(sessions.data?.length ?? 0) > 1 ? (
              <Button className="mt-3" size="sm" variant="secondary" onClick={() => revoke.mutate({ allOthers: true })}>
                Sign out all other sessions
              </Button>
            ) : null}
          </>
        )}
      </Card>

      <Card title="Connected accounts" description="Sign in faster with Discord or Google. Accounts are matched by verified email.">
        <ul className="grid gap-2">
          {(["discord", "google"] as const).map((provider) => {
            const linked = profile.oauth.find((o) => o.provider === provider);
            const available = profile.oauthProviders[provider];
            return (
              <li key={provider} className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                <span className="text-[13px] font-medium capitalize">
                  {provider}
                  {linked ? <span className="ml-2 font-normal text-fg-muted">connected{linked.username ? ` as ${linked.username}` : ""}</span> : null}
                </span>
                {linked ? (
                  <span className="text-[12px] text-state-approved">Connected</span>
                ) : available ? (
                  <Button size="xs" variant="secondary" asChild>
                    <a href={`/api/auth/oauth/${provider}?next=/account/security`}>Connect</a>
                  </Button>
                ) : (
                  <span className="text-[12px] text-fg-subtle">Not configured on this server</span>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
