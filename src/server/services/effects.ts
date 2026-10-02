import { emitNotifications, emitProjectChange } from "../realtime/bus";

/**
 * Collects side effects produced inside a transaction and publishes them only
 * after it commits — clients never hear about changes that were rolled back.
 */
export class Effects {
  private projects = new Map<string, { cardIds: Set<string>; board: boolean }>();
  private notified = new Set<string>();

  project(projectId: string, cardIds: Array<string | null | undefined> = [], board = true) {
    const entry = this.projects.get(projectId) ?? { cardIds: new Set<string>(), board: false };
    for (const id of cardIds) if (id) entry.cardIds.add(id);
    entry.board ||= board;
    this.projects.set(projectId, entry);
    return this;
  }

  card(projectId: string, cardId: string, board = true) {
    return this.project(projectId, [cardId], board);
  }

  notify(userIds: Iterable<string>) {
    for (const id of userIds) this.notified.add(id);
    return this;
  }

  flush(clientId?: string | null) {
    for (const [projectId, entry] of this.projects) {
      emitProjectChange(projectId, [...entry.cardIds], { board: entry.board, clientId });
    }
    if (this.notified.size) emitNotifications(this.notified);
    this.projects.clear();
    this.notified.clear();
  }
}
