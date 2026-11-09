import type { Metadata } from "next";
import Link from "next/link";
import { signOut } from "@/lib/actions/auth";
import { requireUser } from "@/lib/session";
import { AuthScreen } from "@/components/auth/auth-screen";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { buttonClass } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";

export const metadata: Metadata = { title: "Change password" };

export default async function ChangePasswordPage() {
  const { user } = await requireUser({ allowPasswordChange: true });
  const forced = user.mustChangePassword;
  return (
    <AuthScreen
      title={forced ? "Choose a new password" : "Change password"}
      description={
        forced
          ? "You signed in with a temporary password. Choose your own to continue."
          : "Your other sessions will be signed out."
      }
      footer={
        forced ? (
          <form action={signOut}>
            <SubmitButton variant="ghost" size="sm">
              Sign out
            </SubmitButton>
          </form>
        ) : (
          <Link href="/workspace" className={buttonClass("ghost", "sm")}>
            Back to workspace
          </Link>
        )
      }
    >
      <ChangePasswordForm username={user.username} />
    </AuthScreen>
  );
}
