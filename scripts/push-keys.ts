/**
 * Prints a new VAPID key pair for device notifications (Web Push).
 *   npm run push:keys
 * Put the three lines in .env (local) or your host's environment settings (production). The
 * private key is a secret: never commit it. Changing the keys later invalidates every existing
 * device subscription (people turn device notifications on again).
 */
import { generateVapidKeys } from "../src/server/push/web-push";

const keys = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log("VAPID_SUBJECT=mailto:you@example.com");
