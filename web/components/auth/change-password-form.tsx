"use client";

import { useActionState } from "react";
import { changePassword, type ChangePasswordState } from "@/lib/actions/auth";
import { PASSWORD_MIN_LENGTH } from "@/lib/limits";
import { Field } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";

const INITIAL: ChangePasswordState = { fieldErrors: {} };

export function ChangePasswordForm({ username }: { username: string }) {
  const [state, action] = useActionState(changePassword, INITIAL);
  const errors = state.fieldErrors;
  return (
    <form action={action} className="flex flex-col gap-4">
      {/* Lets password managers file the new password under the right account. */}
      <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
      <Field
        label="Current password"
        name="currentPassword"
        type="password"
        tone="login"
        autoComplete="current-password"
        required
        autoFocus
        error={errors.currentPassword}
      />
      <Field
        label="New password"
        name="newPassword"
        type="password"
        tone="login"
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN_LENGTH}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        error={errors.newPassword}
      />
      <Field
        label="Confirm new password"
        name="confirmPassword"
        type="password"
        tone="login"
        autoComplete="new-password"
        required
        error={errors.confirmPassword}
      />
      <SubmitButton size="lg" className="w-full" pendingLabel="Saving…">
        Change password
      </SubmitButton>
    </form>
  );
}
