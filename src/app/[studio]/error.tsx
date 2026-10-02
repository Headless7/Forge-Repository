"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/** Friendly boundary for anything that throws while rendering studio pages. */
export default function StudioError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className="text-lg font-semibold">Something went wrong loading this page.</h2>
      <p className="max-w-md text-[13px] text-fg-muted">Your work is safe. Try again — if it keeps happening, refresh the page.</p>
      {error.digest ? <p className="font-mono text-[11px] text-fg-subtle">Reference: {error.digest}</p> : null}
      <div className="mt-2 flex gap-2">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Button variant="ghost" onClick={() => window.location.reload()}>
          Refresh
        </Button>
      </div>
    </div>
  );
}
