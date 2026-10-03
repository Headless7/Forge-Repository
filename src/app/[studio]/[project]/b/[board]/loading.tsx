import { Skeleton } from "@/components/ui/controls";

/** Board shell appears instantly; columns stream in. */
export default function BoardLoading() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border bg-surface/80 px-4 py-2.5">
        <Skeleton className="size-6 rounded-md" />
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-6 w-28" />
        <span className="flex-1" />
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-7 w-24" />
      </div>
      <div className="flex flex-1 gap-3 overflow-hidden p-4">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex w-[288px] shrink-0 flex-col gap-2 rounded-xl border border-border bg-surface/60 p-2">
            <Skeleton className="h-5 w-24" />
            {Array.from({ length: 3 - (i % 2) }, (_, j) => (
              <Skeleton key={j} className={j === 0 && i % 3 !== 2 ? "h-52" : "h-20"} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
