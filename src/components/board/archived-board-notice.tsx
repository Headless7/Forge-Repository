"use client";

import { ArchiveRestore, FolderArchive } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useRpcMutation } from "@/lib/queries";
import type { ProjectDTO } from "@/lib/types";
import { Button } from "../ui/button";

/** Shown at an archived board's address instead of a bare "not found". */
export function ArchivedBoardNotice({ studioSlug, project, boardId, boardName, canRestore }: { studioSlug: string; project: ProjectDTO; boardId: string; boardName: string; canRestore: boolean }) {
  const router = useRouter();
  const restore = useRpcMutation("board.archive", {
    onSuccess: () => {
      toast.success(`“${boardName}” restored.`);
      router.refresh();
    },
  });
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface-2 p-6 text-center">
        <FolderArchive className="mx-auto size-6 text-fg-subtle" />
        <h1 className="mt-3 text-[15px] font-semibold">
          {project.icon} {project.name} · {boardName} is archived
        </h1>
        <p className="mt-1 text-[13px] text-fg-muted">Its columns and cards are kept, hidden until the board is restored.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button asChild variant="secondary">
            <Link href={`/${studioSlug}/${project.slug}`}>Open the project</Link>
          </Button>
          {canRestore ? (
            <Button variant="primary" loading={restore.isPending} onClick={() => restore.mutate({ boardId, archived: false })}>
              <ArchiveRestore /> Restore board
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
