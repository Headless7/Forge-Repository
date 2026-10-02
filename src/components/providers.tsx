"use client";

import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { toast, Toaster } from "sonner";
import { RpcError } from "@/lib/rpc-client";
import { TooltipProvider } from "./ui/menu";

function ConnectionWatcher() {
  useEffect(() => {
    return onlineManager.subscribe((online) => {
      if (!online) toast.warning("Network connection lost — changes will retry when you're back online.", { id: "offline", duration: Infinity });
      else toast.success("Back online.", { id: "offline", duration: 2500 });
    });
  }, []);
  return null;
}

export function Providers({ children, theme }: { children: ReactNode; theme: "dark" | "light" | "system" }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 20_000,
            refetchOnWindowFocus: true,
            retry: (count, error) => {
              if (error instanceof RpcError && error.status >= 400 && error.status < 500) return false;
              return count < 2;
            },
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={350} skipDelayDuration={150}>
        {children}
        <ConnectionWatcher />
        <Toaster
          theme={theme === "system" ? "system" : theme}
          position="bottom-right"
          closeButton
          toastOptions={{
            classNames: {
              toast: "!bg-surface-2 !border-border-strong !text-fg !shadow-lg",
              description: "!text-fg-muted",
            },
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
