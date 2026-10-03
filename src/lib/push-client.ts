"use client";

/**
 * Browser side of device notifications. Permission is only ever requested from an explicit
 * "Enable device notifications" click — never on page load or when a preference changes.
 */
import { rpc } from "./rpc-client";

export type PushSupport =
  | "supported"
  /** iPhone/iPad: Web Push works only for sites added to the Home Screen (iOS 16.4+). */
  | "ios-needs-install"
  | "unsupported";

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const apis = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (ios && !standalone) return "ios-needs-install";
  return apis && window.isSecureContext ? "supported" : "unsupported";
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported";
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) return existing;
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "supported") return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type EnableResult = { ok: true } | { ok: false; reason: "denied" | "dismissed" | "unsupported" | "unavailable" | "error"; message?: string };

/** Asks for permission (only if not yet decided), subscribes this browser and registers it for the signed-in person. */
export async function enableDevicePush(): Promise<EnableResult> {
  if (pushSupport() !== "supported") return { ok: false, reason: "unsupported" };
  const config = await rpc("push.config", {});
  if (!config.available || !config.publicKey) return { ok: false, reason: "unavailable" };
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission === "denied") return { ok: false, reason: "denied" };
  if (permission !== "granted") return { ok: false, reason: "dismissed" };
  try {
    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();
    // A subscription made with another server key can't receive our messages: replace it.
    const key = sub?.options.applicationServerKey;
    if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== config.publicKey) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) });
    const json = sub.toJSON();
    await rpc("push.subscribe", { endpoint: json.endpoint!, p256dh: json.keys!.p256dh!, auth: json.keys!.auth! });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Stops notifications to this browser: forgets it on the server and unsubscribes it. */
export async function disableDevicePush(): Promise<void> {
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return;
  await rpc("push.unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

/**
 * Whether this browser currently delivers to the signed-in person. A subscription left over from
 * someone else (shared computer) or an ended sign-in is unsubscribed, so it can't be confused with
 * the current person's choice; they can turn it on again explicitly.
 */
export async function syncDevicePush(): Promise<boolean> {
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return false;
  const status = await rpc("push.status", { endpoint: sub.endpoint }).catch(() => null);
  if (!status) return false;
  if (!status.subscribed) {
    await sub.unsubscribe().catch(() => {});
    return false;
  }
  return true;
}

/** Signs out after detaching this browser's device notifications (so the next person here never gets them). */
export async function signOutEverywhereOnThisDevice(): Promise<void> {
  await disableDevicePush().catch(() => {});
  await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
}
