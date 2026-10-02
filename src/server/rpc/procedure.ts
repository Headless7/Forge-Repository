import type { z } from "zod";
import type { SessionUser } from "../auth/session";
import type { Actor } from "../services/context";

export interface RpcContext {
  actor: Actor;
  user: SessionUser;
}

export interface Procedure<TInput extends z.ZodType, TOutput> {
  input: TInput;
  /** Optional per-user budget on top of the global RPC limit. */
  limit?: { max: number; windowMs: number };
  handler: (ctx: RpcContext, input: z.output<TInput>) => Promise<TOutput>;
}

export function proc<TInput extends z.ZodType, TOutput>(definition: Procedure<TInput, TOutput>) {
  return definition;
}
