"use client";

import { useActionState } from "react";
import { updateProfile, type ProfileState } from "@/lib/actions/admin";
import { FormError } from "@/components/forms/form-error";
import { SubmitButton } from "@/components/forms/submit-button";
import { CheckIcon } from "@/components/ui/icons";
import { NameFields } from "./name-fields";

const IDLE: ProfileState = { status: "idle" };

interface ProfileFormProps {
  userId: number;
  firstName: string;
  middleName: string | null;
  lastName: string;
}

/** The user page's name form: Save shows "Saved" once stored, or the server's errors under the fields. */
export function ProfileForm({ userId, firstName, middleName, lastName }: ProfileFormProps) {
  const [state, action] = useActionState(updateProfile, IDLE);
  const errors = state.status === "invalid" ? state.fieldErrors : {};
  const values = state.status === "invalid" ? state.values : { firstName, middleName, lastName };
  return (
    <form action={action} className="flex flex-col gap-4 p-3.5">
      <input type="hidden" name="userId" value={userId} />
      <NameFields values={values} errors={errors} />
      {state.status === "error" ? <FormError>{state.message}</FormError> : null}
      <div className="flex items-center justify-end gap-3">
        {state.status === "saved" ? (
          <span role="status" className="flex items-center gap-1 text-13 text-muted-foreground">
            <CheckIcon className="text-success" />
            Saved
          </span>
        ) : null}
        <SubmitButton size="sm" pendingLabel="Saving…">
          Save
        </SubmitButton>
      </div>
    </form>
  );
}
