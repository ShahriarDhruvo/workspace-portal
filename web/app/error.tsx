"use client";

import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-6">
      <Brand size="lg" />
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-16 font-medium">Something went wrong</h1>
        <p className="text-14 text-muted-foreground">The portal hit an unexpected error. Details are in the server log.</p>
      </div>
      <Button type="button" variant="outline" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
