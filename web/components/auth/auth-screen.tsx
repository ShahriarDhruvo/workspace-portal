import type { ReactNode } from "react";
import { Brand } from "@/components/brand";
import { ThemeToggle } from "@/components/common/theme-toggle";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

/** The full-screen pages without the top bar (sign-in, the forced password change, not found, an error). */
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
