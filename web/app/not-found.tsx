import Link from "next/link";
import { AuthScreen } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";

/**
 * Any address with nothing behind it: the sign-in screen's card. notFound() in a signed-in page (a user page of a
 * deleted user) gets app/(portal)/not-found.tsx instead, under the top bar.
 */
export default function NotFound() {
  return (
    <AuthScreen title="Page not found" description="There is nothing at this address.">
      <Button asChild className="w-full">
        <Link href="/">Go to the portal</Link>
      </Button>
    </AuthScreen>
  );
}
