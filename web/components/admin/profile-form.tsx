"use client";

import { useActionState, type ReactNode } from "react";
import type { ProfileState } from "@/lib/profile";
import { FormError } from "@/components/forms/form-error";
import { SubmitButton } from "@/components/forms/submit-button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { CheckIcon } from "@/components/ui/icons";
import { NameFields } from "./name-fields";

interface ProfileFormProps {
  /** The server action that stores the name: the admin's updateProfile (with userId) or Settings' saveName. */
  action: (previous: ProfileState, formData: FormData) => Promise<ProfileState>;
  /** Whose name it is, for the admin's form; Settings saves the signed-in user's own. */
  userId?: number;
  firstName: string;
  middleName: string | null;
  lastName: string;
  /** Shown above the name fields in the same card body (Settings' account facts). */
  children?: ReactNode;
}

/**
 * The body of a Profile or Account card: the name fields, then Save in the card's footer, which says "Saved"
 * once stored; the server's errors show under the fields.
 */
export function ProfileForm({ action: save, userId, firstName, middleName, lastName, children }: ProfileFormProps) {
  const [state, action] = useActionState(save, { status: "idle" });
  const errors = state.status === "invalid" ? state.fieldErrors : {};
  const values = state.status === "invalid" ? state.values : { firstName, middleName, lastName };
  return (
    <form action={action} className="contents">
      {userId === undefined ? null : <input type="hidden" name="userId" value={userId} />}
      <CardContent className="flex flex-col gap-5">
        {children}
        <NameFields values={values} errors={errors} />
        {state.status === "error" ? <FormError>{state.message}</FormError> : null}
      </CardContent>
      <CardFooter className="justify-end gap-4">
        {state.status === "saved" ? (
          <span role="status" className="flex items-center gap-1.5 text-13 text-muted-foreground">
            <CheckIcon className="shrink-0 text-success" />
            Saved
          </span>
        ) : null}
        <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
      </CardFooter>
    </form>
  );
}
