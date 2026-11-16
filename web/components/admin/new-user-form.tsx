"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { createUser, type CreateUserState } from "@/lib/actions/admin";
import { PASSWORD_MIN_LENGTH } from "@/lib/limits";
import { generateTemporaryPassword } from "@/lib/password-generator";
import { SecretValue } from "@/components/common/secret-value";
import { FormField } from "@/components/forms/form-field";
import { SubmitButton } from "@/components/forms/submit-button";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { CheckIcon, RefreshIcon } from "@/components/ui/icons";
import { NameFields } from "./name-fields";

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
      <Card className="px-4">
        <CardTitle className="flex items-center gap-2">
          <span className="inline-flex size-6 items-center justify-center rounded-full bg-success/14 text-success">
            <CheckIcon />
          </span>
          User created
        </CardTitle>
        <CardDescription>
          <strong className="font-medium text-foreground">{state.user.name}</strong> can now sign in as{" "}
          <strong className="font-medium text-foreground">{state.user.username}</strong> with this temporary password. It
          is shown only once; they choose their own at first sign-in.
        </CardDescription>
        <SecretValue value={state.temporaryPassword} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button asChild variant="ghost">
            <Link href="/admin/users">Back to users</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/admin/users/${state.user.id}`}>View user</Link>
          </Button>
          <Button type="button" onClick={onAnother}>
            Create another
          </Button>
        </div>
      </Card>
    );
  }

  const errors = state.status === "invalid" ? state.fieldErrors : {};
  const values = state.status === "invalid" ? state.values : undefined;
  return (
    <Card className="px-4">
      <form action={action} className="flex flex-col gap-6">
        <FieldGroup>
          <NameFields values={values} errors={errors} autoFocus />
          <FormField
            label="Username"
            name="username"
            placeholder="ada.lovelace"
            required
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            defaultValue={values?.username}
            hint="3–32 characters: lowercase letters, digits, dots, hyphens or underscores."
            error={errors.username}
          />
          <FormField
            label="Temporary password"
            name="password"
            placeholder="Type or generate one"
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
              <Button type="button" variant="outline" className="pointer-coarse:h-10" onClick={() => setPassword(generateTemporaryPassword())}>
                <RefreshIcon />
                Generate
              </Button>
            }
          />
        </FieldGroup>
        <div className="flex justify-end gap-2 border-t border-border-faint pt-4">
          <Button asChild variant="ghost">
            <Link href="/admin/users">Cancel</Link>
          </Button>
          <SubmitButton pendingLabel="Creating…">Create user</SubmitButton>
        </div>
      </form>
    </Card>
  );
}
