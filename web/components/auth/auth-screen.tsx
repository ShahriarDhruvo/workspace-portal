import type { ReactNode } from "react";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/common/theme-toggle";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Sign-in and forced password-change screen, laid out like the Web Shell's "Connect" card: the brand over a
 * 400px card centred on the canvas, a centred title and description, the form, and a muted footer strip. The
 * theme switch sits in the corner, as in the top bars of the signed-in pages.
 */
export function AuthScreen({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-12">
      <div className="absolute top-2 right-3">
        <ThemeToggle />
      </div>
      <Brand size="lg" />
      <Card role="region" aria-labelledby="auth-title" className="w-full max-w-100 gap-6">
        <CardHeader className="text-center">
          <CardTitle>
            <h1 id="auth-title" className="text-18 font-semibold">
              {title}
            </h1>
          </CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent>{children}</CardContent>
        {footer ? <CardFooter className="justify-center text-center text-12 text-muted-foreground">{footer}</CardFooter> : null}
      </Card>
    </main>
  );
}
