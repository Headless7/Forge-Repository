import { emitNotifications, emitProjectChange } from "../realtime/bus";

/**
 * Collects side effects produced inside a transaction and publishes them only
 * after it commits — clients never hear about changes that were rolled back.
 */
export class Effects {
  private projects = new Map<string, { cardIds: Set<string>; board: boolean; itemIds: Set<string>; forums: boolean }>();
  private notified = new Set<string>();
  private discordQueued = false;

  project(projectId: string, cardIds: Array<string | null | undefined> = [], board = true) {
    const entry = this.projects.get(projectId) ?? { cardIds: new Set<string>(), board: false, itemIds: new Set<string>(), forums: false };
    for (const id of cardIds) if (id) entry.cardIds.add(id);
    entry.board ||= board;
    this.projects.set(projectId, entry);
    return this;
  }

  /** A forum item changed: its detail view and the project's forums refresh (never the boards). */
  item(projectId: string, itemId: string | null | undefined) {
    this.project(projectId, [], false);
    const entry = this.projects.get(projectId)!;
    if (itemId) entry.itemIds.add(itemId);
    entry.forums = true;
    return this;
  }

  card(projectId: string, cardId: string, board = true) {
    return this.project(projectId, [cardId], board);
  }

  notify(userIds: Iterable<string>) {
    for (const id of userIds) this.notified.add(id);
    return this;
  }

  /** Discord feed messages were queued with the change. */
  discord(queued: number | boolean = true) {
    if (queued) this.discordQueued = true;
    return this;
  }

  flush(clientId?: string | null) {
    for (const [projectId, entry] of this.projects) {
      emitProjectChange(projectId, [...entry.cardIds], { board: entry.board, clientId, itemIds: [...entry.itemIds], forums: entry.forums });
    }
    if (this.notified.size) {
      emitNotifications(this.notified);
      // Device notifications queued with the change go out now that it has committed.
      void import("./push").then((m) => m.schedulePushDelivery()).catch(() => {});
      void import("./discord-dm").then((m) => m.scheduleDiscordDmDelivery()).catch(() => {});
    }
    if (this.discordQueued) void import("./discord").then((m) => m.scheduleDiscordDelivery()).catch(() => {});
    this.projects.clear();
    this.notified.clear();
    this.discordQueued = false;
  }
}
