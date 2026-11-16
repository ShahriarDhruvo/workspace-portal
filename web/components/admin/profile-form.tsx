"use client";

import { useActionState } from "react";
import { updateProfile, type ProfileState } from "@/lib/actions/admin";
import { FormError } from "@/components/forms/form-error";
import { SubmitButton } from "@/components/forms/submit-button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { CheckIcon } from "@/components/ui/icons";
import { NameFields } from "./name-fields";

const IDLE: ProfileState = { status: "idle" };

interface ProfileFormProps {
  userId: number;
  firstName: string;
  middleName: string | null;
  lastName: string;
}

/**
 * The body of a user page's Profile card: the name fields, then Save in the card's footer, which says "Saved"
 * once stored; the server's errors show under the fields.
 */
export function ProfileForm({ userId, firstName, middleName, lastName }: ProfileFormProps) {
  const [state, action] = useActionState(updateProfile, IDLE);
  const errors = state.status === "invalid" ? state.fieldErrors : {};
  const values = state.status === "invalid" ? state.values : { firstName, middleName, lastName };
  return (
    <form action={action} className="contents">
      <input type="hidden" name="userId" value={userId} />
      <CardContent className="flex flex-col gap-4">
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
