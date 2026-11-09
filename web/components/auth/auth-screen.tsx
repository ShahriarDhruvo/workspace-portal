import type { ReactNode } from "react";
import { Brand } from "@/components/brand";

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
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-base p-6">
      <Brand size="lg" />
      <section
        aria-labelledby="auth-title"
        className="flex w-full max-w-md flex-col gap-5 overflow-hidden rounded-3xl border border-line bg-surface pt-4"
      >
        <div className="flex flex-col gap-1 px-4 text-center">
          <h1 id="auth-title" className="text-24 font-medium">
            {title}
          </h1>
          {description ? <p className="text-14 text-fg-muted">{description}</p> : null}
        </div>
        <div className={footer ? "px-4" : "px-4 pb-4"}>{children}</div>
        {footer ? (
          <div className="flex justify-center border-t border-line bg-raised/50 px-4 py-3 text-center text-12 text-fg-muted">
            {footer}
          </div>
        ) : null}
      </section>
    </main>
  );
}
