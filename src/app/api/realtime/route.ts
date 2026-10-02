import { eq } from "drizzle-orm";
import { getProjectAccess } from "@/server/access";
import { requireRouteSession, sessionTokenFrom } from "@/server/auth/route-session";
import { validateSessionToken } from "@/server/auth/session";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { invalid, notFound } from "@/server/errors";
import { errorResponse } from "@/server/http";
import { realtime, type RealtimeEvent } from "@/server/realtime/bus";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
const REVALIDATE_MS = 5 * 60_000;

/**
 * Server-Sent Events stream for one project board (plus the user's own
 * notification pings). Access is re-checked periodically so revoked members
 * stop receiving updates.
 */
export async function GET(req: Request) {
  try {
    const { actor } = await requireRouteSession(req);
    const url = new URL(req.url);
    const projectId = url.searchParams.get("projectId");
    if (projectId && !/^[0-9a-f-]{36}$/i.test(projectId)) throw invalid("Invalid project.");
    if (projectId && !(await getProjectAccess(actor.userId, projectId))) throw notFound("Project");

    const encoder = new TextEncoder();
    let cleanup = () => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const send = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            close();
          }
        };
        const touchPresence = () =>
          db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, actor.userId)).catch(() => {});

        const unsubscribe = realtime().subscribe((event: RealtimeEvent) => {
          if (event.type === "project" && event.projectId === projectId) {
            send(`event: project\ndata: ${JSON.stringify(event)}\n\n`);
          } else if (event.type === "notification" && event.userId === actor.userId) {
            send(`event: notification\ndata: {}\n\n`);
          }
        });
        const heartbeat = setInterval(() => {
          send(`: ping\n\n`);
          void touchPresence();
        }, HEARTBEAT_MS);
        const revalidate = setInterval(async () => {
          const token = sessionTokenFrom(req);
          const session = token ? await validateSessionToken(token) : null;
          const stillAllowed = session && (!projectId || (await getProjectAccess(session.user.id, projectId)));
          if (!stillAllowed) {
            send(`event: revoked\ndata: {}\n\n`);
            close();
          }
        }, REVALIDATE_MS);

        function close() {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          clearInterval(revalidate);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
        cleanup = close;
        req.signal.addEventListener("abort", close);

        void touchPresence();
        send(`retry: 3000\nevent: ready\ndata: {}\n\n`);
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-store, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
