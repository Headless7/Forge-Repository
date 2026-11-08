import type { z } from "zod";
import type { SessionUser } from "../auth/session";
import type { Actor } from "../services/context";

export interface RpcContext {
  actor: Actor;
  user: SessionUser;
}

/**
 * What a token-scoped call is about, read from its validated input. The RPC route resolves it to a
 * project and refuses the call when that project is outside the token's scope.
 */
export type ScopeRef = { projectId: string } | { forumId: string } | { itemId: string };

export interface Procedure<TInput extends z.ZodType, TOutput> {
  input: TInput;
  /** Optional per-user budget on top of the global RPC limit. */
  limit?: { max: number; windowMs: number };
  /**
   * Present only on procedures an API token may call. Procedures without it (account, studio and
   * token management among them) are never reachable with a bearer token.
   */
  scope?: (input: z.output<TInput>) => ScopeRef;
  handler: (ctx: RpcContext, input: z.output<TInput>) => Promise<TOutput>;
}

export function proc<TInput extends z.ZodType, TOutput>(definition: Procedure<TInput, TOutput>) {
  return definition;
}
