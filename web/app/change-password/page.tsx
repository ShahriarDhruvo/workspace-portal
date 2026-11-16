import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { signOut } from "@/lib/actions/auth";
import { requireUser } from "@/lib/session";
import { AuthScreen } from "@/components/auth/auth-screen";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { SubmitButton } from "@/components/forms/submit-button";

export const metadata: Metadata = { title: "Change password" };

/** Only the forced change after signing in with a temporary password; any other change is in Settings. */
export default async function ChangePasswordPage() {
  const { user } = await requireUser({ allowPasswordChange: true });
  if (!user.mustChangePassword) redirect("/settings#password");
  return (
    <AuthScreen
      title="Choose a new password"
      description="You signed in with a temporary password. Choose your own to continue."
      footer={
        <form action={signOut}>
          <SubmitButton variant="ghost" size="sm">
            Sign out
          </SubmitButton>
        </form>
      }
    >
      <ChangePasswordForm username={user.username} temporary />
    </AuthScreen>
  );
}
