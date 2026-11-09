import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Workspace Portal", template: "%s · Workspace Portal" },
  description: "Sign in to your workspace.",
  robots: { index: false, follow: false },
};

// Dark only, like the Web Shell in the workspace iframe: the OS colour scheme is ignored.
export const viewport: Viewport = {
  themeColor: "#0d0d0d",
  colorScheme: "dark",
};

// Paints the dark canvas before any stylesheet loads, so there is never a white flash.
const BOOT_STYLE = "html{background:#0d0d0d;color-scheme:dark}";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: BOOT_STYLE }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
