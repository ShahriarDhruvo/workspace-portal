"use client";

import { useActionState } from "react";
import { updateProfile, type ProfileState } from "@/lib/actions/admin";
import { NAME_MAX_LENGTH } from "@/lib/limits";
import { Field, FormError } from "@/components/ui/field";
import { CheckIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";

const IDLE: ProfileState = { status: "idle" };

interface ProfileFormProps {
  userId: number;
  firstName: string;
  middleName: string | null;
  lastName: string;
}

export function ProfileForm({ userId, firstName, middleName, lastName }: ProfileFormProps) {
  const [state, action] = useActionState(updateProfile, IDLE);
  const errors = state.status === "invalid" ? state.fieldErrors : {};
  const values = state.status === "invalid" ? state.values : { firstName, middleName: middleName ?? "", lastName };
  return (
    <form action={action} className="flex flex-col gap-4 p-3.5">
      <input type="hidden" name="userId" value={userId} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="First name" name="firstName" required maxLength={NAME_MAX_LENGTH} autoComplete="off" defaultValue={values.firstName} error={errors.firstName} />
        <Field label="Middle name" name="middleName" optional maxLength={NAME_MAX_LENGTH} autoComplete="off" defaultValue={values.middleName} error={errors.middleName} />
        <Field label="Last name" name="lastName" required maxLength={NAME_MAX_LENGTH} autoComplete="off" defaultValue={values.lastName} error={errors.lastName} />
      </div>
      {state.status === "error" ? <FormError>{state.message}</FormError> : null}
      <div className="flex items-center justify-end gap-3">
        {state.status === "saved" ? (
          <span role="status" className="flex items-center gap-1 text-13 text-fg-muted">
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
