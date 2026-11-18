"use client";

import { startTransition, useActionState, useOptimistic, useRef, useState } from "react";
import { setOnlineAccess } from "@/lib/actions/admin";
import { FormError } from "@/components/forms/form-error";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { UserDialog, type DialogUser } from "./user-dialogs";

interface OnlineAccessProps {
  user: DialogUser;
  /** users.online_allowed. */
  allowed: boolean;
  /** Their Online workspace is starting or running: turning access off stops it, so that asks first. */
  onlineRunning: boolean;
  /** ONLINE_WORKSPACES=off: nobody can start one, whatever this says. */
  portalOff: boolean;
}

/**
 * A user's "Online workspace" permission on their page, as a switch that saves at once (audited). Turning it off
 * while their Online workspace runs confirms first, as that stops it. While a change saves, the switch ignores
 * presses but stays enabled: a disabled one would drop the keyboard focus to the page on every toggle.
 */
export function OnlineAccess({ user, allowed, onlineRunning, portalOff }: OnlineAccessProps) {
  const [state, save, saving] = useActionState(setOnlineAccess, { status: "idle" });
  // The switch moves at once; the page's next render (the action refreshes it) settles it.
  const [shown, setShown] = useOptimistic(allowed);
  const [confirming, setConfirming] = useState(false);
  const control = useRef<HTMLButtonElement>(null);

  function change(next: boolean) {
    if (saving) return;
    if (!next && onlineRunning) {
      setConfirming(true);
      return;
    }
    const data = new FormData();
    data.set("userId", String(user.id));
    data.set("allowed", String(next));
    startTransition(() => {
      setShown(next);
      save(data);
    });
  }

  return (
    <>
      <Field orientation="horizontal">
        <Switch ref={control} id="online-access" checked={shown} aria-busy={saving || undefined} onCheckedChange={change} />
        <FieldContent>
          <FieldLabel htmlFor="online-access">Online workspace</FieldLabel>
          {portalOff ? <FieldDescription>Turned off on this portal.</FieldDescription> : null}
        </FieldContent>
      </Field>
      {state.status === "error" ? <FormError>{state.message}</FormError> : null}
      <UserDialog kind="onlineOff" user={user} open={confirming} onOpenChange={setConfirming} returnFocusTo={control} />
    </>
  );
}
