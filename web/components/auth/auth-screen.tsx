import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Brand } from "@/components/brand";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Sign-in and password-change screen, laid out like the Web Shell's "Connect" card: a 448px card (#171717,
 * 14px radius, 1px border) centred on the page, a centred 24px title, 44px inputs and button, and a muted
 * footer strip.
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
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background p-6">
      <Brand size="lg" />
      <Card
        role="region"
        aria-labelledby="auth-title"
        className={cn("w-full max-w-md gap-5 overflow-hidden rounded-3xl", footer && "pb-0")}
      >
        <CardHeader className="gap-1 text-center">
          <CardTitle asChild className="text-24">
            <h1 id="auth-title">{title}</h1>
          </CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent>{children}</CardContent>
        {footer ? (
          <CardFooter className="justify-center border-t bg-muted/50 py-3 text-center text-12 text-muted-foreground">
            {footer}
          </CardFooter>
        ) : null}
      </Card>
    </main>
  );
}
