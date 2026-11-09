import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { AuthScreen } from "@/components/auth/auth-screen";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const session = await getSession();
  if (session) redirect(session.user.mustChangePassword ? "/change-password" : "/workspace");
  const { working } = await searchParams;
  return (
    <AuthScreen
      title="Sign in"
      description="Use the account your administrator gave you."
      footer={<p>Workspaces run Qwen Code</p>}
    >
      {working === "1" ? (
        <p role="status" className="mb-4 rounded-md border border-line bg-raised/50 px-3 py-2 text-13 text-fg-muted">
          You&apos;re signed out. Your agent is still working, so your workspace keeps running until the task
          finishes, then stops by itself.
        </p>
      ) : null}
      <LoginForm />
    </AuthScreen>
  );
}
