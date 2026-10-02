"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/account/profile", label: "Profile" },
  { href: "/account/notifications", label: "Notifications" },
  { href: "/account/security", label: "Password & security" },
];

export function AccountNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Account" className="mt-4 flex gap-1 border-b border-border">
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          aria-current={pathname === l.href ? "page" : undefined}
          className={cn("-mb-px border-b-2 px-2.5 pb-2 text-[13px] font-medium", pathname === l.href ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg")}
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
