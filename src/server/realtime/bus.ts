import { EventEmitter } from "node:events";
import { rawSql } from "../db";
import { env } from "../env";

/**
 * Realtime events are deliberately small "something changed" signals; clients
 * re-fetch the affected board/card. This keeps payloads under NOTIFY's 8 KB limit
 * and guarantees clients always converge on the authoritative server state.
 */
export type RealtimeEvent =
  | {
      type: "project";
      projectId: string;
      /** Cards whose detail view should refresh. */
      cardIds: string[];
      /** Whether the board listing changed (cards added/moved/restyled, columns …). */
      board: boolean;
      /** Browser tab that caused the change, so it can skip its own echo. */
      clientId?: string | null;
    }
  | { type: "notification"; userId: string }
  /** The user's studio or project access changed: their open streams re-check it right away. */
  | { type: "access"; userId: string };

export interface RealtimeBus {
  publish(event: RealtimeEvent): Promise<void>;
  subscribe(listener: (event: RealtimeEvent) => void): () => void;
}

const CHANNEL = "forge_events";

class MemoryBus implements RealtimeBus {
  protected emitter = new EventEmitter().setMaxListeners(0);
  async publish(event: RealtimeEvent) {
    this.emitter.emit("event", event);
  }
  subscribe(listener: (event: RealtimeEvent) => void) {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }
}

class PostgresBus extends MemoryBus {
  private listening: Promise<unknown> | null = null;

  override async publish(event: RealtimeEvent) {
    await rawSql()`select pg_notify(${CHANNEL}, ${JSON.stringify(event)})`;
  }

  override subscribe(listener: (event: RealtimeEvent) => void) {
    this.listening ??= rawSql()
      .listen(CHANNEL, (payload) => {
        try {
          this.emitter.emit("event", JSON.parse(payload) as RealtimeEvent);
        } catch {
          // ignore malformed payloads
        }
      })
      .catch((error) => {
        console.error("[forge] realtime LISTEN failed", error);
        this.listening = null;
      });
    return super.subscribe(listener);
  }
}

const g = globalThis as unknown as { __forgeBus?: RealtimeBus };

export function realtime(): RealtimeBus {
  g.__forgeBus ??= env.REALTIME_DRIVER === "postgres" ? new PostgresBus() : new MemoryBus();
  return g.__forgeBus;
}

const MAX_CARD_IDS = 100;

/** Fire-and-forget: a failed broadcast must never fail the user's write. */
export function emitProjectChange(
  projectId: string,
  cardIds: Array<string | null | undefined>,
  options: { board?: boolean; clientId?: string | null } = {},
) {
  const ids = [...new Set(cardIds.filter((id): id is string => Boolean(id)))];
  const event: RealtimeEvent = {
    type: "project",
    projectId,
    cardIds: ids.length > MAX_CARD_IDS ? [] : ids,
    board: options.board ?? true,
    clientId: options.clientId ?? null,
  };
  realtime()
    .publish(event)
    .catch((error) => console.error("[forge] realtime publish failed", error));
}

export function emitNotifications(userIds: Iterable<string>) {
  for (const userId of new Set(userIds)) {
    realtime()
      .publish({ type: "notification", userId })
      .catch((error) => console.error("[forge] realtime publish failed", error));
  }
}

/** Tells the user's open streams to re-check their access now (removal, role or scope change). */
export function announceAccessChange(userId: string) {
  realtime()
    .publish({ type: "access", userId })
    .catch((error) => console.error("[forge] realtime publish failed", error));
}
