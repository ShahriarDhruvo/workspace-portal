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
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { CheckIcon, RefreshIcon } from "@/components/ui/icons";
import { Switch } from "@/components/ui/switch";
import { NameFields } from "./name-fields";

const IDLE: CreateUserState = { status: "idle" };

/** Create-user form; after success it shows the temporary password once. "Create another" remounts it. */
export function NewUser() {
  const [round, setRound] = useState(0);
  return <NewUserForm key={round} onAnother={() => setRound((n) => n + 1)} />;
}

/**
 * The names in a row, then username and temporary password side by side (all stacked on a phone), the "Online
 * workspace" permission (on by default, as the user page's switch), and the buttons in the card's footer, as on
 * the other forms.
 */
function NewUserForm({ onAnother }: { onAnother: () => void }) {
  const [state, action] = useActionState(createUser, IDLE);
  const [password, setPassword] = useState("");

  if (state.status === "created") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="flex items-center gap-2 text-16">
              <span className="inline-flex size-6 items-center justify-center rounded-full bg-success/14 text-success">
                <CheckIcon />
              </span>
              User created
            </h2>
          </CardTitle>
          <CardDescription>
            <strong className="font-medium text-foreground">{state.user.name}</strong> signs in as{" "}
            <strong className="font-medium text-foreground">{state.user.username}</strong> with this temporary password,
            shown only once, and chooses their own at first sign-in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SecretValue value={state.temporaryPassword} />
        </CardContent>
        <CardFooter className="flex-wrap justify-end gap-2">
          <Button asChild variant="ghost">
            <Link href="/admin/users">Back to users</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/admin/users/${state.user.id}`}>View user</Link>
          </Button>
          <Button type="button" onClick={onAnother}>
            Create another
          </Button>
        </CardFooter>
      </Card>
    );
  }

  const errors = state.status === "invalid" ? state.fieldErrors : {};
  const values = state.status === "invalid" ? state.values : undefined;
  return (
    <Card>
      <form action={action} className="contents">
        <CardContent className="flex flex-col gap-5">
          <NameFields values={values} errors={errors} newUser />
          <div className="grid grid-cols-1 items-start gap-x-4 gap-y-5 sm:grid-cols-2">
            <FormField
              label="Username"
              name="username"
              placeholder="ada.lovelace"
              required
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              defaultValue={values?.username}
              hint="3–32 characters: a–z, 0–9, . - _"
              error={errors.username}
            />
            <FormField
              label="Temporary password"
              name="password"
              placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
              required
              minLength={PASSWORD_MIN_LENGTH}
              autoComplete="off"
              spellCheck={false}
              mono
              // The rule in the proportional font, which fits a phone-width field; the password itself in mono.
              className="placeholder:font-sans"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={errors.password}
              addon={
                <Button type="button" variant="outline" className="pointer-coarse:h-10" onClick={() => setPassword(generateTemporaryPassword())}>
                  <RefreshIcon />
                  Generate
                </Button>
              }
            />
          </div>
          <Field orientation="horizontal">
            <Switch id="field-onlineAllowed" name="onlineAllowed" defaultChecked={values ? values.onlineAllowed === "on" : true} />
            <FieldLabel htmlFor="field-onlineAllowed">Online workspace</FieldLabel>
          </Field>
        </CardContent>
        <CardFooter className="justify-end gap-2">
          <Button asChild variant="ghost">
            <Link href="/admin/users">Cancel</Link>
          </Button>
          <SubmitButton pendingLabel="Creating…">Create user</SubmitButton>
        </CardFooter>
      </form>
    </Card>
  );
}
