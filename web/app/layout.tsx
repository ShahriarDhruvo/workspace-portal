import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { parseTheme, THEME_CANVAS, THEME_COOKIE, themeBootStyle, themeClass, type Theme } from "@/lib/theme";
import { ThemeProvider } from "@/components/common/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Workspace Portal", template: "%s · Workspace Portal" },
  description: "Sign in to your workspace.",
  robots: { index: false, follow: false },
};

/** The theme saved in the portal_theme cookie (dark unless it says light; the OS colour scheme is ignored). */
async function savedTheme(): Promise<Theme> {
  return parseTheme((await cookies()).get(THEME_COOKIE)?.value);
}

export async function generateViewport(): Promise<Viewport> {
  const theme = await savedTheme();
  return { themeColor: THEME_CANVAS[theme], colorScheme: theme };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await savedTheme();
  return (
    <html lang="en" className={themeClass(theme)} style={{ colorScheme: theme }}>
      <head>
        {/* Paints the theme's canvas before any stylesheet loads, so there is never a flash of the other one. */}
        <style dangerouslySetInnerHTML={{ __html: themeBootStyle(theme) }} />
      </head>
      <body>
        <ThemeProvider theme={theme}>
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
