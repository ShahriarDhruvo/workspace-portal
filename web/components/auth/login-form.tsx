"use client";

import { useActionState } from "react";
import { login, type LoginState } from "@/lib/actions/auth";
import { Field, FormError } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";

const INITIAL: LoginState = { error: null, username: "" };

export function LoginForm() {
  const [state, action] = useActionState(login, INITIAL);
  const invalid = state.error !== null || undefined;
  return (
    <form action={action} className="flex flex-col gap-4">
      {state.error ? <FormError>{state.error}</FormError> : null}
      <Field
        label="Username"
        name="username"
        tone="login"
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        autoFocus
        defaultValue={state.username}
        aria-invalid={invalid}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        tone="login"
        autoComplete="current-password"
        required
        aria-invalid={invalid}
      />
      <SubmitButton size="lg" className="w-full" pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}
