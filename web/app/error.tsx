"use client";

import { AuthScreen } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";

/** An unexpected error while rendering a page: the sign-in screen's card, with Try again (renders the page anew). */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <AuthScreen title="Something went wrong" description="The portal hit an unexpected error. Details are in the server log.">
      <Button type="button" className="w-full" onClick={reset}>
        Try again
      </Button>
    </AuthScreen>
  );
}
