"use client";

import { useActionState } from "react";
import { changePassword, type ChangePasswordState } from "@/lib/actions/auth";
import { PASSWORD_MIN_LENGTH } from "@/lib/limits";
import { FormField } from "@/components/forms/form-field";
import { SubmitButton } from "@/components/forms/submit-button";
import { FieldGroup } from "@/components/ui/field";

const INITIAL: ChangePasswordState = { fieldErrors: {} };

/** `temporary`: the current password is the one an administrator issued (the forced change at first sign-in). */
export function ChangePasswordForm({ username, temporary }: { username: string; temporary: boolean }) {
  const [state, action] = useActionState(changePassword, INITIAL);
  const errors = state.fieldErrors;
  return (
    <form action={action} className="flex flex-col gap-6">
      {/* Lets password managers file the new password under the right account. */}
      <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
      <FieldGroup>
        <FormField
          label="Current password"
          name="currentPassword"
          type="password"
          variant="login"
          placeholder={temporary ? "The temporary password" : "Your current password"}
          autoComplete="current-password"
          required
          autoFocus
          error={errors.currentPassword}
        />
        <FormField
          label="New password"
          name="newPassword"
          type="password"
          variant="login"
          placeholder="Choose a new password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
          error={errors.newPassword}
        />
        <FormField
          label="Confirm new password"
          name="confirmPassword"
          type="password"
          variant="login"
          placeholder="The new password again"
          autoComplete="new-password"
          required
          error={errors.confirmPassword}
        />
      </FieldGroup>
      <SubmitButton size="lg" className="w-full" pendingLabel="Saving…">
        Change password
      </SubmitButton>
    </form>
  );
}
