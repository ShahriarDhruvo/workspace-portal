"use client";

import { useActionState } from "react";
import { changePassword, type ChangePasswordState } from "@/lib/actions/auth";
import { PASSWORD_MIN_LENGTH } from "@/lib/limits";
import { cn } from "@/lib/utils";
import { FormField } from "@/components/forms/form-field";
import { SubmitButton } from "@/components/forms/submit-button";
import { FieldGroup } from "@/components/ui/field";
import { CheckIcon } from "@/components/ui/icons";

const INITIAL: ChangePasswordState = { fieldErrors: {} };

/**
 * `temporary`: the forced change at first sign-in, on its own screen, where the current password is the one an
 * administrator issued; it leads on to Home. Otherwise the Password section of Settings, which stays put and
 * says when the change is done.
 */
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
          placeholder={temporary ? "The temporary password" : "Your current password"}
          autoComplete="current-password"
          required
          autoFocus={temporary}
          error={errors.currentPassword}
        />
        <FormField
          label="New password"
          name="newPassword"
          type="password"
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
          placeholder="The new password again"
          autoComplete="new-password"
          required
          error={errors.confirmPassword}
        />
      </FieldGroup>
      <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2", !temporary && "justify-end")}>
        {state.changedAt ? (
          <p key={state.changedAt} role="status" className="flex items-center gap-1.5 text-13 text-success">
            <CheckIcon className="shrink-0" />
            Password changed. Your other sessions were signed out.
          </p>
        ) : null}
        <SubmitButton size={temporary ? "lg" : "default"} className={cn(temporary && "w-full")} pendingLabel="Saving…">
          Change password
        </SubmitButton>
      </div>
    </form>
  );
}
