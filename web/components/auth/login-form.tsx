"use client";

import { useActionState } from "react";
import { login, type LoginState } from "@/lib/actions/auth";
import { FormError } from "@/components/forms/form-error";
import { FormField } from "@/components/forms/form-field";
import { SubmitButton } from "@/components/forms/submit-button";
import { FieldGroup } from "@/components/ui/field";

const INITIAL: LoginState = { error: null, username: "" };

export function LoginForm() {
  const [state, action] = useActionState(login, INITIAL);
  const invalid = state.error !== null || undefined;
  return (
    <form action={action} className="flex flex-col gap-6">
      <FieldGroup>
        {state.error ? <FormError>{state.error}</FormError> : null}
        <FormField
          label="Username"
          name="username"
          placeholder="ada.lovelace"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          autoFocus
          defaultValue={state.username}
          aria-invalid={invalid}
        />
        <FormField
          label="Password"
          name="password"
          type="password"
          placeholder="Your password"
          autoComplete="current-password"
          required
          aria-invalid={invalid}
        />
      </FieldGroup>
      <SubmitButton size="lg" className="w-full" pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}
