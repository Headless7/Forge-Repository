"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Download } from "lucide-react";
import Link from "next/link";
import { rpc } from "@/lib/rpc-client";
import { useShell } from "../shell/shell-context";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/controls";
import { downloadCsv } from "./project-dashboard";

/** One row per project: how far along, what's at risk, review queue, this week's approvals. */
export function StudioDashboard() {
  const { studio } = useShell();
  const rows = useQuery({ queryKey: ["dashboard-studio", studio.id], queryFn: () => rpc("dashboard.studio", { studioId: studio.id }), staleTime: 30_000 });
  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-4 px-4 py-6 md:px-8">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] text-fg-subtle">{studio.name}</p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">Studio dashboard</h1>
            <p className="mt-0.5 text-[12.5px] text-fg-muted">Projects you manage. Open one for its full dashboard.</p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!rows.data?.length}
            onClick={() =>
              downloadCsv(`forge-${studio.slug}-projects-${new Date().toISOString().slice(0, 10)}.csv`, [
                ["Project", "Open deliverables", "Required approved", "Overdue", "Blocked", "In review", "Approved in the last 7 days"],
                ...(rows.data ?? []).map((r) => [r.project.name, r.open, `${r.requiredApproved} of ${r.required}`, r.overdue, r.blocked, r.queue, r.approvedThisWeek]),
              ])
            }
          >
            <Download /> Export CSV
          </Button>
        </div>
        {rows.isLoading ? (
          <Skeleton className="h-48" />
        ) : !rows.data?.length ? (
          <p className="rounded-xl border border-border bg-surface-2 p-6 text-[13px] text-fg-muted">No projects to report on yet.</p>
        ) : (
          <div className="scrollbar-thin overflow-x-auto rounded-xl border border-border bg-surface-2">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead>
                <tr className="text-[11.5px] text-fg-subtle">
                  <th className="px-4 py-2 font-medium">Project</th>
                  <th className="px-2 py-2 text-right font-medium">Open</th>
                  <th className="px-2 py-2 font-medium">Required approved</th>
                  <th className="px-2 py-2 text-right font-medium">Overdue</th>
                  <th className="px-2 py-2 text-right font-medium">Blocked</th>
                  <th className="px-2 py-2 text-right font-medium">In review</th>
                  <th className="px-4 py-2 text-right font-medium">Approved (7 days)</th>
                </tr>
              </thead>
              <tbody>
                {rows.data.map((r) => {
                  const p = r.required ? Math.round((r.requiredApproved / r.required) * 100) : 0;
                  return (
                    <tr key={r.project.id} className="border-t border-border/70">
                      <td className="px-4 py-2">
                        <Link href={`/${studio.slug}/${r.project.slug}/dashboard`} className="inline-flex min-h-8 items-center gap-2 font-medium hover:underline">
                          <span aria-hidden>{r.project.icon}</span> {r.project.name}
                        </Link>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{r.open}</td>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-accent/20" role="meter" aria-valuemin={0} aria-valuemax={r.required} aria-valuenow={r.requiredApproved} aria-label={`${r.project.name}: required approved`}>
                            <div className="h-full rounded-full bg-accent" style={{ width: `${p}%` }} />
                          </div>
                          <span className="text-[12px] tabular-nums text-fg-muted">
                            {r.requiredApproved}/{r.required}
                          </span>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {r.overdue ? (
                          <span className="inline-flex items-center gap-1 font-semibold">
                            <CircleAlert className="size-3.5 text-danger" aria-label="overdue" />
                            {r.overdue}
                          </span>
                        ) : (
                          0
                        )}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{r.blocked}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{r.queue}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.approvedThisWeek}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
