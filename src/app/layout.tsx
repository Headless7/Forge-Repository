import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { getSession } from "@/server/auth/current";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Forge", template: "%s · Forge" },
  description: "Production boards and media review for Roblox game studios.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0c0d10",
  width: "device-width",
  initialScale: 1,
};

const SYSTEM_THEME_SCRIPT = `try{var m=window.matchMedia('(prefers-color-scheme: light)');document.documentElement.dataset.theme=m.matches?'light':'dark';}catch(e){}`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  const theme = session?.user.themePreference ?? "dark";
  // Per-request CSP nonce from src/proxy.ts (production): inline scripts without it don't run.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      data-theme={theme === "light" ? "light" : "dark"}
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>{theme === "system" ? <script nonce={nonce} dangerouslySetInnerHTML={{ __html: SYSTEM_THEME_SCRIPT }} /> : null}</head>
      <body>
        <Providers theme={theme}>{children}</Providers>
      </body>
    </html>
  );
}
