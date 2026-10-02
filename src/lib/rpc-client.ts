import type { z } from "zod";
import type { AppRouter } from "@/server/rpc/router";

export type RpcName = keyof AppRouter;
export type RpcInput<K extends RpcName> = z.input<AppRouter[K]["input"]>;
export type RpcOutput<K extends RpcName> = Awaited<ReturnType<AppRouter[K]["handler"]>>;

export class RpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

let clientId: string | null = null;
/** Identifies this browser tab so realtime echoes of its own changes can be ignored. */
export function getClientId(): string {
  if (typeof window === "undefined") return "server";
  clientId ??= crypto.randomUUID();
  return clientId;
}

let redirecting = false;

export async function rpc<K extends RpcName>(name: K, input: RpcInput<K>, options: { signal?: AbortSignal } = {}): Promise<RpcOutput<K>> {
  let res: Response;
  try {
    res = await fetch(`/api/rpc/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-client-id": getClientId() },
      body: JSON.stringify(input ?? {}),
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw error;
    throw new RpcError("NETWORK", "Network connection lost — changes will retry.", 0);
  }
  const payload = (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string; details?: Record<string, unknown> } } | null;
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && !redirecting) {
      redirecting = true;
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.assign(`/sign-in?next=${next}&expired=1`);
    }
    const err = payload?.error;
    throw new RpcError(err?.code ?? "INTERNAL", err?.message ?? "Something went wrong. Please try again.", res.status, err?.details);
  }
  return payload?.data as RpcOutput<K>;
}

export function errorMessage(error: unknown): string {
  if (error instanceof RpcError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Please try again.";
}
