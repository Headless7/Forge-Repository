import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-3 px-6 py-20 text-center">
      <p className="font-mono text-sm text-fg-subtle">404</p>
      <h1 className="text-xl font-semibold">This page doesn&apos;t exist, or you don&apos;t have access to it.</h1>
      <p className="max-w-md text-[13px] text-fg-muted">If someone sent you this link, ask them to invite you to the studio or project.</p>
      <Link href="/" className="mt-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover">
        Go to your studio
      </Link>
    </main>
  );
}
