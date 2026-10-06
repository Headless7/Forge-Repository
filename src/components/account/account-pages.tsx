"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BellOff, BellRing, Camera, Laptop, LogOut, MailCheck, MailWarning, Monitor, Moon, Send, Smartphone, Sun, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { NOTIFICATION_TYPE_META } from "@/lib/notifications";
import { currentSubscription, disableDevicePush, enableDevicePush, notificationPermission, pushSupport, syncDevicePush } from "@/lib/push-client";
import { qk, useRpcMutation } from "@/lib/queries";
import { errorMessage, rpc, type RpcOutput } from "@/lib/rpc-client";
import { cn, formatDateTime, timeAgo } from "@/lib/utils";
import { displayNameSchema, emailSchema, passwordSchema, usernameSchema } from "@/lib/validation";
import { UserAvatar } from "../domain/avatar";
import { Button } from "../ui/button";
import { useTutorial } from "../tutorial/tutorial";
import { Skeleton, Switch } from "../ui/controls";
import { ConfirmDialog } from "../ui/dialog";
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

      <TutorialTipsCard />
    </div>
  );
}

/** Turn contextual tips on or off, or see dismissed ones again. */
function TutorialTipsCard() {
  const tutorial = useTutorial();
  if (!tutorial.available) return null;
  return (
    <Card title="Tutorial tips" description="Short tips that appear beside a feature the first time you use it. Progress is saved to your account, so each tip appears once on any device.">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="tutorial-tips" className="min-w-0 text-[13px] font-medium">
          Show tutorial tips
        </label>
        <Switch id="tutorial-tips" checked={tutorial.enabled} onCheckedChange={(on) => tutorial.setEnabled(on)} />
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <p className="min-w-0 flex-1 text-[12.5px] text-fg-muted">Bring back tips you&apos;ve dismissed. Each one appears again the next time you use its feature — nothing opens straight away.</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            tutorial.reset();
            toast.success("Tutorial tips reset. They'll appear again as you use each feature.");
          }}
        >
          Reset tips
        </Button>
      </div>
    </Card>
  );
}

type DeviceState =
  | { kind: "checking" }
  | { kind: "unsupported" }
  | { kind: "ios-needs-install" }
  | { kind: "blocked" }
  | { kind: "off"; dismissed?: boolean }
  | { kind: "on" };

/** This browser's device-notification status, with the explicit enable/disable/test actions. */
function ThisDevice({ available, onChange }: { available: boolean; onChange: () => void }) {
  const [state, setState] = useState<DeviceState>({ kind: "checking" });
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const support = pushSupport();
    if (support !== "supported") return setState({ kind: support });
    if (notificationPermission() === "denied") return setState({ kind: "blocked" });
    setState((await syncDevicePush()) ? { kind: "on" } : { kind: "off" });
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = async () => {
    setBusy(true);
    const result = await enableDevicePush();
    setBusy(false);
    if (result.ok) {
      setState({ kind: "on" });
      toast.success("Device notifications are on for this browser.");
    } else if (result.reason === "denied") {
      setState({ kind: "blocked" });
    } else if (result.reason === "dismissed") {
      setState({ kind: "off", dismissed: true });
    } else if (result.reason === "unavailable") {
      toast.error("Device notifications aren't set up on this server.");
    } else {
      toast.error(result.message ? `Couldn't turn on device notifications: ${result.message}` : "This browser can't receive device notifications.");
    }
    onChange();
  };
  const disable = async () => {
    setBusy(true);
    await disableDevicePush();
    setBusy(false);
    setState({ kind: "off" });
    onChange();
  };
  const test = async () => {
    const sub = await currentSubscription();
    if (!sub) return;
    setBusy(true);
    const result = await rpc("push.test", { endpoint: sub.endpoint }).catch((error) => {
      toast.error(errorMessage(error));
      return null;
    });
    setBusy(false);
    const r = result?.results[0];
    if (r?.ok) toast.success("Test sent — it should appear on this device in a moment. (If this tab has focus, check your system's notification center.)");
    else if (r) toast.error(`The push service refused the test: ${r.error ?? "unknown error"}`);
  };

  const status: Record<DeviceState["kind"], { text: string; tone: string }> = {
    checking: { text: "Checking this browser…", tone: "text-fg-muted" },
    unsupported: { text: "This browser can't show device notifications.", tone: "text-fg-muted" },
    "ios-needs-install": { text: "On iPhone and iPad, add Forge to your Home Screen first (Share → Add to Home Screen), then open it from there.", tone: "text-fg-muted" },
    blocked: { text: "Notifications are blocked for this site in your browser settings. Allow them there (the lock or site-settings icon by the address), then come back.", tone: "text-warning" },
    off: { text: "Off on this browser.", tone: "text-fg-muted" },
    on: { text: "On — this browser gets device notifications for the types switched on below.", tone: "text-state-approved" },
  };
  return (
    <div className="rounded-lg border border-border-strong p-3">
      <div className="flex flex-wrap items-center gap-3">
        <BellRing className="size-5 shrink-0 text-fg-subtle" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">This device</p>
          <p className={cn("text-[12.5px]", status[state.kind].tone)} role="status">
            {status[state.kind].text}
            {state.kind === "off" && state.dismissed ? " You closed the browser's question without choosing — you can try again." : ""}
          </p>
        </div>
        {available && state.kind === "off" ? (
          <Button variant="primary" size="sm" loading={busy} onClick={() => void enable()}>
            <BellRing /> Enable device notifications
          </Button>
        ) : null}
        {state.kind === "on" ? (
          <div className="flex flex-wrap gap-1.5">
            <Button variant="secondary" size="sm" loading={busy} onClick={() => void test()}>
              <Send /> Send a test
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disable()}>
              <BellOff /> Turn off on this device
            </Button>
          </div>
        ) : null}
      </div>
      {available && state.kind === "off" ? (
        <p className="mt-2 text-[12px] text-fg-muted">
          Get a system notification for review requests, approvals, deadlines and mentions even when Forge isn&apos;t open. Your browser will ask for permission once. Delivery depends on the
          browser and system: they can be delayed while the device is offline or in battery saving, and a notification already shown can&apos;t always be taken back.
        </p>
      ) : null}
    </div>
  );
}

function YourDevices({ refreshKey }: { refreshKey: number }) {
  const queryClient = useQueryClient();
  const devices = useQuery({ queryKey: ["push-devices", refreshKey], queryFn: () => rpc("push.devices", {}) });
  const remove = useRpcMutation("push.removeDevice", { onSuccess: (list) => queryClient.setQueryData(["push-devices", refreshKey], list) });
  if (!devices.data?.length) return null;
  return (
    <div className="mt-3">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">Devices receiving notifications</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {devices.data.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{d.label}</span>
              {d.thisSession ? <span className="text-fg-subtle"> · this sign-in</span> : null}
              <span className="block text-[11.5px] text-fg-subtle">
                added {timeAgo(d.createdAt)}
                {d.lastSuccessAt ? ` · last delivered ${timeAgo(d.lastSuccessAt)}` : ""}
                {d.failing ? " · recent deliveries failed" : ""}
              </span>
            </span>
            <Button size="xs" variant="ghost" loading={remove.isPending && remove.variables?.id === d.id} onClick={() => remove.mutate({ id: d.id })}>
              <Trash2 /> Remove
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NotificationPreferencesPage() {
  const queryClient = useQueryClient();
  const prefs = useQuery({ queryKey: qk.notificationPrefs(), queryFn: () => rpc("notification.preferences", {}) });
  const set = useRpcMutation("notification.setPreference", { onSuccess: (data) => queryClient.setQueryData(qk.notificationPrefs(), data) });
  const [devicesKey, setDevicesKey] = useState(0);
  const emailAvailable = prefs.data?.emailAvailable ?? false;
  const pushAvailable = prefs.data?.pushAvailable ?? false;
  const groups = [...new Set(Object.values(NOTIFICATION_TYPE_META).map((m) => m.group))];
  const channels: Array<{ id: "inApp" | "push" | "email"; label: string; aria: string }> = [
    { id: "inApp", label: "In-app", aria: "in Forge" },
    { id: "push", label: "Device", aria: "on your devices" },
    ...(emailAvailable ? [{ id: "email" as const, label: "Email", aria: "by email" }] : []),
  ];
  return (
    <div className="grid gap-5">
      <Card
        title="Device notifications"
        description={
          pushAvailable
            ? "Operating-system notifications on the browsers and phones you turn them on for — also when Forge isn't open. Each device is turned on separately."
            : "Device notifications aren't set up on this server yet, so nothing can be sent to your devices."
        }
      >
        <ThisDevice available={pushAvailable} onChange={() => setDevicesKey((k) => k + 1)} />
        {pushAvailable ? <YourDevices refreshKey={devicesKey} /> : null}
      </Card>
      <Card
        title="What to notify you about"
        description={`For each kind of notification, choose where it goes: In-app (your notification center and its unread count)${pushAvailable ? ", Device (system notifications on your devices)" : ""}${emailAvailable ? " or Email" : ""}. The choices are independent and apply to your whole account; changing them never asks your browser for anything.`}
      >
        {prefs.isLoading || !prefs.data ? (
          <div className="grid gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : (
          <div className="grid gap-5">
            {groups.map((group) => (
              <section key={group} aria-label={group}>
                <div className="flex items-center gap-4 border-b border-border pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                  <span className="flex-1">{group}</span>
                  {channels.map((c) => (
                    <span key={c.id} className="hidden w-14 text-center sm:block">
                      {c.label}
                    </span>
                  ))}
                </div>
                <ul className="divide-y divide-border">
                  {prefs.data.types
                    .filter((p) => NOTIFICATION_TYPE_META[p.type].group === group)
                    .map((p) => {
                      const meta = NOTIFICATION_TYPE_META[p.type];
                      return (
                        <li key={p.type} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-medium">{meta.label}</span>
                            <span className="block text-[12px] text-fg-muted">{meta.description}</span>
                          </span>
                          <span className="flex gap-4">
                            {channels.map((c) => {
                              const disabled = c.id === "push" && !pushAvailable;
                              return (
                                <label key={c.id} className={cn("flex items-center gap-2 sm:w-14 sm:justify-center", disabled && "opacity-50")}>
                                  <Switch
                                    checked={p[c.id] && !disabled}
                                    disabled={disabled}
                                    onCheckedChange={(v) => set.mutate({ type: p.type, [c.id]: v })}
                                    aria-label={`${meta.label} ${c.aria}`}
                                  />
                                  <span className="text-[12px] text-fg-muted sm:sr-only">{c.label}</span>
                                </label>
                              );
                            })}
                          </span>
                        </li>
                      );
                    })}
                </ul>
              </section>
            ))}
          </div>
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

      <ConnectedAccounts profile={profile} />
    </div>
  );
}

const PROVIDER_LABELS = { discord: "Discord", google: "Google" } as const;

/** Sign-in providers. Connecting Discord also turns on Forge's direct messages there. */
function ConnectedAccounts({ profile }: { profile: Profile }) {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  // Back from connecting an account (?connected=discord or ?oauthError=…): shown once, then the URL is tidied.
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(() => {
    const error = searchParams.get("oauthError");
    if (error) return { tone: "error", text: error.slice(0, 300) };
    const connected = searchParams.get("connected");
    if (connected === "discord") return { tone: "success", text: "Discord connected. Forge sent you a welcome message there." };
    if (connected === "google") return { tone: "success", text: "Google connected." };
    return null;
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    const connected = url.searchParams.get("connected");
    if (!connected && !url.searchParams.has("oauthError")) return;
    url.searchParams.delete("connected");
    url.searchParams.delete("oauthError");
    url.searchParams.delete("ns");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (connected !== "discord") return;
    // The welcome message goes out right away; if Discord refuses it, show that here.
    const timer = setTimeout(() => void queryClient.invalidateQueries({ queryKey: qk.profile() }), 4000);
    return () => clearTimeout(timer);
  }, [queryClient]);
  const [disconnecting, setDisconnecting] = useState<"discord" | "google" | null>(null);
  const disconnect = useRpcMutation("account.disconnectAccount", {
    onSuccess: (next, { provider }) => {
      queryClient.setQueryData(qk.profile(), next);
      setDisconnecting(null);
      setNotice(null);
      toast.success(`${PROVIDER_LABELS[provider]} disconnected.`);
    },
  });
  const retry = useRpcMutation("account.retryDiscordDms", {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.profile() });
      toast.success("Forge can message you on Discord again.");
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: qk.profile() }),
  });
  // Without a password, the last connected account is the only way to sign in.
  const onlyWayIn = !profile.hasPassword && profile.oauth.length === 1;
  const dms = profile.discordDms;

  return (
    <Card title="Connected accounts" description="Sign in faster with Discord or Google. Accounts are matched by verified email.">
      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={cn("mb-3 rounded-lg border px-3 py-2 text-[12.5px]", notice.tone === "error" ? "border-danger/40 bg-danger/10 text-danger" : "border-state-approved/40 bg-state-approved/10")}
        >
          {notice.text}
        </p>
      ) : null}
      <ul className="grid gap-2">
        {(["discord", "google"] as const).map((provider) => {
          const linked = profile.oauth.find((o) => o.provider === provider);
          const available = profile.oauthProviders[provider];
          return (
            <li key={provider} className="rounded-lg border border-border px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 text-[13px] font-medium">
                  {PROVIDER_LABELS[provider]}
                  {linked ? <span className="ml-2 font-normal text-fg-muted">connected{linked.username ? ` as ${linked.username}` : ""}</span> : null}
                </span>
                {linked ? (
                  <Button size="xs" variant="ghost" disabled={onlyWayIn} onClick={() => setDisconnecting(provider)}>
                    Disconnect
                  </Button>
                ) : available ? (
                  <Button size="xs" variant="secondary" asChild>
                    <a href={`/api/auth/oauth/${provider}?next=/account/security`}>Connect</a>
                  </Button>
                ) : (
                  <span className="text-[12px] text-fg-subtle">Not configured on this server</span>
                )}
              </div>
              {provider === "discord" && dms.available && linked && dms.paused ? (
                <div role="alert" className="mt-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px]">
                  <p className="flex items-start gap-1.5 font-medium">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" /> Forge can&apos;t send you direct messages
                  </p>
                  <p className="mt-0.5 text-fg-muted">{dms.reason}</p>
                  {dms.servers.length ? <p className="mt-0.5 text-fg-muted">The Forge bot is in: {dms.servers.join(", ")}.</p> : null}
                  <Button className="mt-2" size="xs" variant="secondary" loading={retry.isPending} onClick={() => retry.mutate({})}>
                    Try again
                  </Button>
                </div>
              ) : provider === "discord" && dms.available && linked ? (
                <p className="mt-1 text-[12px] text-fg-muted">
                  Forge sends you direct messages on Discord when your work is due soon or overdue, about reviews and assignments, and when someone mentions or replies to you. In Discord, <code className="font-mono">/mywork</code>, <code className="font-mono">/reviews</code>, <code className="font-mono">/card</code> and <code className="font-mono">/due</code> show your work and let you act on it, and <code className="font-mono">/newcard</code> creates a card — only you see the replies.
                </p>
              ) : provider === "discord" && dms.available && available ? (
                <p className="mt-1 text-[12px] text-fg-muted">Connect it to also get direct messages from Forge about your deadlines, reviews and mentions, and to use Forge&apos;s commands in Discord (/mywork, /reviews, /card, /due, /newcard).</p>
              ) : null}
              {linked && onlyWayIn ? <p className="mt-1 text-[11.5px] text-fg-subtle">To disconnect, set a password above first, so you can still sign in.</p> : null}
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={Boolean(disconnecting)}
        onOpenChange={(open) => !open && setDisconnecting(null)}
        title={`Disconnect ${disconnecting ? PROVIDER_LABELS[disconnecting] : ""}?`}
        description={
          disconnecting === "discord"
            ? "You won't be able to sign in with Discord, and Forge stops sending you direct messages there. You can connect it again any time."
            : "You won't be able to sign in with Google. You can connect it again any time."
        }
        confirmLabel="Disconnect"
        loading={disconnect.isPending}
        onConfirm={() => disconnecting && disconnect.mutate({ provider: disconnecting })}
      />
    </Card>
  );
}
