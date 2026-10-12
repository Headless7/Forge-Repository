import { Skeleton } from "@/components/ui/controls";

export default function BugsLoading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <Skeleton className="h-3 w-40" />
      <Skeleton className="mt-2 h-7 w-24" />
      <div className="mt-5 flex gap-1.5">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-28 rounded-full" />
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="mt-4 grid gap-px overflow-hidden rounded-xl border border-border">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-14 rounded-none" />
        ))}
      </div>
    </div>
  );
}
