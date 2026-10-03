"use client";

import { useMutation, useQueryClient, type UseMutationOptions } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage, rpc, RpcError, type RpcInput, type RpcName, type RpcOutput } from "./rpc-client";
import type { CardDetailDTO } from "./types";

export const qk = {
  /** Every board of a project (a prefix: invalidating it refreshes whichever board is open). */
  board: (projectId: string) => ["board", projectId] as const,
  /** One board's contents. */
  boardView: (projectId: string, boardId: string) => ["board", projectId, boardId] as const,
  card: (cardId: string) => ["card", cardId] as const,
  cardByNumber: (projectId: string, number: number) => ["card-number", projectId, number] as const,
  cardActivity: (cardId: string) => ["card-activity", cardId] as const,
  notifications: () => ["notifications"] as const,
  unread: () => ["notifications", "unread"] as const,
  projects: (studioId: string) => ["projects", studioId] as const,
  home: (studioId: string) => ["home", studioId] as const,
  members: (studioId: string) => ["members", studioId] as const,
  invitations: (studioId: string) => ["invitations", studioId] as const,
  projectActivity: (projectId: string, all: boolean) => ["project-activity", projectId, all] as const,
  projectAccess: (projectId: string) => ["project-access", projectId] as const,
  archived: (projectId: string) => ["archived", projectId] as const,
  profile: () => ["profile"] as const,
  sessions: () => ["sessions"] as const,
  notificationPrefs: () => ["notification-prefs"] as const,
  search: (studioId: string, projectId: string | null, q: string) => ["search", studioId, projectId, q] as const,
};

export function isNetworkError(error: unknown) {
  return error instanceof RpcError && error.code === "NETWORK";
}

type Options<K extends RpcName, C> = Omit<UseMutationOptions<RpcOutput<K>, Error, RpcInput<K>, C>, "mutationFn"> & {
  /** Suppress the default error toast. */
  silent?: boolean;
};

/**
 * Mutation bound to an RPC procedure. Network failures are retried with backoff
 * (and paused while offline); other failures surface as a toast.
 */
export function useRpcMutation<K extends RpcName, C = unknown>(name: K, options: Options<K, C> = {}) {
  const { silent, onError, ...rest } = options;
  return useMutation<RpcOutput<K>, Error, RpcInput<K>, C>({
    mutationFn: (input) => rpc(name, input),
    retry: (count, error) => isNetworkError(error) && count < 6,
    retryDelay: (attempt) => Math.min(800 * 2 ** attempt, 15_000),
    ...rest,
    onError: (error, variables, context, mutationContext) => {
      if (!silent) toast.error(errorMessage(error));
      onError?.(error, variables, context, mutationContext);
    },
  });
}

/** Mutations that return a full card: write it straight into the cache and refresh the board tile. */
export function useCardMutation<K extends RpcName>(name: K, cardId: string, projectId: string, options: Options<K, unknown> = {}) {
  const queryClient = useQueryClient();
  return useRpcMutation(name, {
    ...options,
    onSuccess: (data, variables, context, mutationContext) => {
      const maybeCard = data as unknown as CardDetailDTO | undefined;
      if (maybeCard && typeof maybeCard === "object" && "versions" in maybeCard && maybeCard.id === cardId) {
        queryClient.setQueryData(qk.card(cardId), maybeCard);
      } else {
        void queryClient.invalidateQueries({ queryKey: qk.card(cardId) });
      }
      void queryClient.invalidateQueries({ queryKey: qk.board(projectId) });
      void queryClient.invalidateQueries({ queryKey: qk.cardActivity(cardId) });
      options.onSuccess?.(data, variables, context, mutationContext);
    },
  });
}
