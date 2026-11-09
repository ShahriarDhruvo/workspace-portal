"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { createUser, type CreateUserState } from "@/lib/actions/admin";
import { NAME_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/limits";
import { generateTemporaryPassword } from "@/lib/password-generator";
import { buttonClass } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SecretValue } from "@/components/ui/copy-button";
import { Field } from "@/components/ui/field";
import { CheckIcon, RefreshIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";

const IDLE: CreateUserState = { status: "idle" };

/** Create-user form; after success it shows the temporary password once. "Create another" remounts it. */
export function NewUser() {
  const [round, setRound] = useState(0);
  return <NewUserForm key={round} onAnother={() => setRound((n) => n + 1)} />;
}

function NewUserForm({ onAnother }: { onAnother: () => void }) {
  const [state, action] = useActionState(createUser, IDLE);
  const [password, setPassword] = useState("");

  if (state.status === "created") {
    return (
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-2 text-16 font-medium">
          <span className="inline-flex size-6 items-center justify-center rounded-full bg-success/14 text-success">
            <CheckIcon />
          </span>
          User created
        </div>
        <p className="text-14 text-fg-muted">
          <strong className="font-medium text-fg">{state.user.name}</strong> can now sign in as{" "}
          <strong className="font-medium text-fg">{state.user.username}</strong> with this temporary password. It is
          shown only once; they choose their own at first sign-in.
        </p>
        <SecretValue value={state.temporaryPassword} />
        <div className="flex flex-wrap justify-end gap-2">
          <Link href="/admin" className={buttonClass("ghost")}>
            Back to users
          </Link>
          <Link href={`/admin/users/${state.user.id}`} className={buttonClass("outline")}>
            View user
          </Link>
          <button type="button" className={buttonClass("primary")} onClick={onAnother}>
            Create another
          </button>
        </div>
      </Card>
    );
  }

  const errors = state.status === "invalid" ? state.fieldErrors : {};
  const values = state.status === "invalid" ? state.values : undefined;
  return (
    <Card className="p-4">
      <form action={action} className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field
            label="First name"
            name="firstName"
            required
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            autoFocus
            defaultValue={values?.firstName}
            error={errors.firstName}
          />
          <Field
            label="Middle name"
            name="middleName"
            optional
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            defaultValue={values?.middleName}
            error={errors.middleName}
          />
          <Field
            label="Last name"
            name="lastName"
            required
            maxLength={NAME_MAX_LENGTH}
            autoComplete="off"
            defaultValue={values?.lastName}
            error={errors.lastName}
          />
        </div>
        <Field
          label="Username"
          name="username"
          required
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          defaultValue={values?.username}
          hint="3–32 characters: lowercase letters, digits, dots, hyphens or underscores."
          error={errors.username}
        />
        <Field
          label="Temporary password"
          name="password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          autoComplete="off"
          spellCheck={false}
          mono
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. The user must change it at first sign-in.`}
          error={errors.password}
          addon={
            <button
              type="button"
              className={buttonClass("outline", "md")}
              onClick={() => setPassword(generateTemporaryPassword())}
            >
              <RefreshIcon />
              Generate
            </button>
          }
        />
        <div className="flex justify-end gap-2 border-t border-line-faint pt-4">
          <Link href="/admin" className={buttonClass("ghost")}>
            Cancel
          </Link>
          <SubmitButton pendingLabel="Creating…">Create user</SubmitButton>
        </div>
      </form>
    </Card>
  );
}
