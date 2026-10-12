import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ForumPage } from "@/components/forums/forum-page";
import { getProjectAccessBySlug } from "@/server/access";
import { actorFor, requireSession } from "@/server/auth/current";
import { findForumIdBySlug, getForumView } from "@/server/services/forums";
import { listProjectMembers } from "@/server/services/members-query";

type Params = Promise<{ studio: string; project: string; forum: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { forum } = await params;
  return { title: forum === "bugs" ? "Bugs" : forum === "qa" ? "QA" : "Forum" };
}

/** One forum of the project: /studio/project/f/bugs, /f/qa, or a custom forum's slug. */
export default async function ProjectForumPage({ params }: { params: Params }) {
  const { studio, project, forum } = await params;
  const session = await requireSession();
  const access = await getProjectAccessBySlug(session.user.id, studio, project);
  if (!access) notFound();
  const actor = actorFor(session);
  const forumId = await findForumIdBySlug(actor, access.project.id, forum).catch(() => null);
  if (!forumId) notFound();
  const [initial, members] = await Promise.all([getForumView(actor, forumId), listProjectMembers(access.project)]);
  return <ForumPage initial={initial} members={members} studioSlug={studio} projectSlug={project} />;
}
