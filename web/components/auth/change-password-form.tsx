"use client";

import { useActionState } from "react";
import { changePassword, type ChangePasswordState } from "@/lib/actions/auth";
import { PASSWORD_MIN_LENGTH } from "@/lib/limits";
import { FormField } from "@/components/forms/form-field";
import { SubmitButton } from "@/components/forms/submit-button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { CheckIcon } from "@/components/ui/icons";

const INITIAL: ChangePasswordState = { fieldErrors: {} };

/**
 * `temporary`: the forced change at first sign-in, on its own screen, which leads on to Home. Otherwise the body of
 * Settings' Password card.
 */
export function ChangePasswordForm({ username, temporary }: { username: string; temporary: boolean }) {
  const [state, action] = useActionState(changePassword, INITIAL);
  const errors = state.fieldErrors;
  const fields = (
    <>
      <FormField
        label={temporary ? "Temporary password" : "Current password"}
        name="currentPassword"
        type="password"
        placeholder={temporary ? "From your administrator" : "Current"}
        autoComplete="current-password"
        required
        autoFocus={temporary}
        error={errors.currentPassword}
      />
      <FormField
        label="New password"
        name="newPassword"
        type="password"
        placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
        autoComplete="new-password"
        required
        minLength={PASSWORD_MIN_LENGTH}
        error={errors.newPassword}
      />
      <FormField
        label="Confirm password"
        name="confirmPassword"
        type="password"
        placeholder="Type it again"
        autoComplete="new-password"
        required
        error={errors.confirmPassword}
      />
    </>
  );
  // Lets password managers file the new password under the right account.
  const account = <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />;

  if (temporary) {
    return (
      <form action={action} className="flex flex-col gap-6">
        {account}
        <FieldGroup>{fields}</FieldGroup>
        <SubmitButton className="w-full" pendingLabel="Saving…">
          Change password
        </SubmitButton>
      </form>
    );
  }

  return (
    <form action={action} className="contents">
      {account}
      <CardContent>
        <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-3">{fields}</div>
      </CardContent>
      <CardFooter className="flex-wrap justify-end gap-x-4 gap-y-2">
        {state.changedAt ? (
          <p key={state.changedAt} role="status" className="flex items-center gap-1.5 text-13 text-muted-foreground">
            <CheckIcon className="shrink-0 text-success" />
            Changed. Your other sessions were signed out.
          </p>
        ) : null}
        <SubmitButton pendingLabel="Saving…">Change password</SubmitButton>
      </CardFooter>
    </form>
  );
}
