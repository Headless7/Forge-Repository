import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-full items-start justify-center overflow-hidden px-4 py-[8vh] sm:items-center sm:py-12">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(ellipse at 50% 30%, black 20%, transparent 70%)",
        }}
      />
      <div className="relative w-full max-w-[400px]">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
            <path d="M16 3 L28 16 L16 29 L4 16 Z" fill="var(--accent)" />
            <path d="M16 9.5 L22 16 L16 22.5 L10 16 Z" fill="#ece9ff" />
          </svg>
          <span className="text-lg font-semibold tracking-tight">Forge</span>
        </div>
        {children}
      </div>
    </main>
  );
}
