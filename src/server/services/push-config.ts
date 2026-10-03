import { env } from "../env";
import { validateVapidKeys, type VapidKeys } from "../push/web-push";

let cached: { keys: VapidKeys | null; error: string | null } | null = null;

/**
 * The server's VAPID keys, when device notifications are set up (VAPID_PUBLIC_KEY,
 * VAPID_PRIVATE_KEY and VAPID_SUBJECT). Invalid keys count as "not set up" — and are logged — so a
 * typo never turns into failed deliveries.
 */
export function vapidKeys(): VapidKeys | null {
  if (cached) return cached.keys;
  const e = env;
  if (!e.VAPID_PUBLIC_KEY || !e.VAPID_PRIVATE_KEY) {
    cached = { keys: null, error: null };
    return null;
  }
  const keys: VapidKeys = {
    publicKey: e.VAPID_PUBLIC_KEY,
    privateKey: e.VAPID_PRIVATE_KEY,
    subject: e.VAPID_SUBJECT ?? `mailto:no-reply@${new URL(e.APP_URL).hostname}`,
  };
  try {
    validateVapidKeys(keys);
    cached = { keys, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[push] Device notifications are off: ${message}`);
    cached = { keys: null, error: message };
  }
  return cached.keys;
}

export function pushConfigured(): boolean {
  return vapidKeys() !== null;
}

