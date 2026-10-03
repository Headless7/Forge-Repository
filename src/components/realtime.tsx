"use client";

import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { qk } from "@/lib/queries";
import { getClientId } from "@/lib/rpc-client";

type Status = "connecting" | "live" | "offline";

interface RealtimeContextValue {
  status: Status;
  setProjectId: (id: string | null) => void;
}

const RealtimeContext = createContext<RealtimeContextValue>({ status: "connecting", setProjectId: () => {} });

export function useRealtimeStatus() {
  return useContext(RealtimeContext).status;
}

/** Board pages call this to join their project's event stream. */
export function useRealtimeProject(projectId: string | null) {
  const { setProjectId } = useContext(RealtimeContext);
  useEffect(() => {
    setProjectId(projectId);
    return () => setProjectId(null);
  }, [projectId, setProjectId]);
}

interface ProjectEvent {
  type: "project";
  projectId: string;
  cardIds: string[];
  board: boolean;
  clientId?: string | null;
}

/**
 * One Server-Sent Events connection per tab. Events are small "something changed"
 * signals; affected queries are invalidated (debounced) so every client converges
 * on the authoritative server state.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const pending = useRef<{ boards: Set<string>; cards: Set<string>; notifications: boolean; timer: ReturnType<typeof setTimeout> | null }>({
    boards: new Set(),
    cards: new Set(),
    notifications: false,
    timer: null,
  });

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let disposed = false;
    let hadConnection = false;

    const flush = () => {
      const p = pending.current;
      p.timer = null;
      for (const id of p.boards) void queryClient.invalidateQueries({ queryKey: qk.board(id) });
      for (const id of p.cards) {
        void queryClient.invalidateQueries({ queryKey: qk.card(id) });
        void queryClient.invalidateQueries({ queryKey: qk.cardActivity(id) });
      }
      if (p.notifications) void queryClient.invalidateQueries({ queryKey: qk.notifications() });
      p.boards.clear();
      p.cards.clear();
      p.notifications = false;
    };
    const schedule = () => {
      if (!pending.current.timer) pending.current.timer = setTimeout(flush, 200);
    };

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");
      source = new EventSource(`/api/realtime${projectId ? `?projectId=${projectId}` : ""}`);
      source.addEventListener("ready", () => {
        attempts = 0;
        setStatus("live");
        // Catch up on changes made before the stream was open: between the server rendering the
        // page and this connection (first load), or while disconnected (reconnects).
        if (projectId) void queryClient.invalidateQueries({ queryKey: qk.board(projectId) });
        if (hadConnection) {
          void queryClient.invalidateQueries({ queryKey: ["card"] });
          void queryClient.invalidateQueries({ queryKey: qk.notifications() });
        }
        hadConnection = true;
      });
      source.addEventListener("project", (e) => {
        const event = JSON.parse((e as MessageEvent<string>).data) as ProjectEvent;
        const own = event.clientId === getClientId();
        if (event.board && !own) pending.current.boards.add(event.projectId);
        for (const id of event.cardIds) if (!own) pending.current.cards.add(id);
        // Our own writes still change other people's views of shared data (e.g. activity); refresh lightly.
        if (own) for (const id of event.cardIds) void queryClient.invalidateQueries({ queryKey: qk.cardActivity(id) });
        schedule();
      });
      source.addEventListener("notification", () => {
        pending.current.notifications = true;
        schedule();
      });
      source.addEventListener("revoked", () => {
        source?.close();
        window.location.reload();
      });
      source.onerror = () => {
        if (source?.readyState === EventSource.CLOSED) {
          setStatus("offline");
          source.close();
          attempts += 1;
          retryTimer = setTimeout(connect, Math.min(30_000, 2000 * attempts));
        } else {
          setStatus("connecting");
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [projectId, queryClient]);

  return <RealtimeContext.Provider value={{ status, setProjectId }}>{children}</RealtimeContext.Provider>;
}
