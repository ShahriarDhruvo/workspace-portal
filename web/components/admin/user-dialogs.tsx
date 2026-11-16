"use client";

import { useActionState, useEffect, useEffectEvent, useRef, useState, type ReactNode, type RefObject } from "react";
import { deleteUser, resetPassword, setUserActive, stopWorkspace, type ActionState } from "@/lib/actions/admin";
import { returnFocus } from "@/lib/focus";
import { SecretValue } from "@/components/common/secret-value";
import { FormError } from "@/components/forms/form-error";
import { FormField } from "@/components/forms/form-field";
import { SubmitButton } from "@/components/forms/submit-button";
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { BusyWarning } from "@/components/workspace/busy-warning";

// The admin's actions on one user (stop the workspace, reset the password, deactivate, activate, delete), each
// as a confirmation dialog bound to its server action. A dialog closes itself once its action succeeds, except
// a password reset, which shows the new temporary password once. Deleting asks for the username first.

export type UserDialogKind = "stop" | "reset" | "deactivate" | "activate" | "delete";

export interface DialogUser {
  id: number;
  name: string;
  username: string;
  /** The user's agent is working right now (the dialogs that stop the workspace at once warn). */
  busy?: boolean;
}

const TITLES: Record<UserDialogKind, string> = {
  stop: "Stop workspace",
  reset: "Reset password",
  deactivate: "Deactivate user",
  activate: "Activate user",
  delete: "Delete user",
};

const IDLE: ActionState = { status: "idle" };

interface UserDialogProps {
  kind: UserDialogKind;
  user: DialogUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Gets the focus back on close: the control that opened the dialog (it has no Trigger), or the menu's button. */
  returnFocusTo?: RefObject<HTMLElement | null>;
}

/** One admin action on one user, as a confirmation dialog. Controlled: the caller owns `open`. */
export function UserDialog({ kind, user, open, onOpenChange, returnFocusTo }: UserDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={returnFocus(returnFocusTo)}>
        <AlertDialogHeader>
          <AlertDialogTitle>{TITLES[kind]}</AlertDialogTitle>
        </AlertDialogHeader>
        <UserDialogBody kind={kind} user={user} onDone={() => onOpenChange(false)} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A button that opens one of the user dialogs (used on the user detail page); closing it refocuses the button. */
export function UserDialogButton({
  kind,
  user,
  children,
  danger = false,
}: {
  kind: UserDialogKind;
  user: DialogUser;
  children: ReactNode;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // The dialog as it was opened. The page can change `kind` under an open dialog: a deactivation that couldn't
  // stop the workspace leaves the account deactivated and its error on screen, and this button now activates.
  const [shown, setShown] = useState(kind);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={button}
        type="button"
        variant={danger ? "destructive-outline" : "outline"}
        size="sm"
        onClick={() => {
          setShown(kind);
          setOpen(true);
        }}
      >
        {children}
      </Button>
      <UserDialog kind={shown} user={user} open={open} onOpenChange={setOpen} returnFocusTo={button} />
    </>
  );
}

/** The open dialog's body. It unmounts when the dialog closes, so each opening starts from a fresh form. */
function UserDialogBody({ kind, user, onDone }: { kind: UserDialogKind; user: DialogUser; onDone: () => void }) {
  const name = <strong className="font-medium text-foreground">{user.name}</strong>;
  const whose = <>{name}&apos;s</>;
  switch (kind) {
    case "stop":
      return (
        <ActionForm
          user={user}
          action={stopWorkspace}
          onDone={onDone}
          confirmLabel="Stop"
          pendingLabel="Stopping…"
          description={
            user.busy ? (
              <p>
                <BusyWarning whose={whose} effect="Stopping ends it mid-way; files written so far are kept. Stop anyway?" />
              </p>
            ) : (
              <p>
                Stop {whose} workspace now? Anything running in it ends; files are kept. It starts again the next time
                it&apos;s opened.
              </p>
            )
          }
        />
      );
    case "reset":
      return (
        <ActionForm
          user={user}
          action={resetPassword}
          onDone={onDone}
          confirmLabel="Reset password"
          pendingLabel="Resetting…"
          description={
            <p>
              {name} is signed out everywhere and gets a new temporary password, which they must change at their next
              sign-in.
            </p>
          }
          renderPassword={(password) => (
            <div className="flex flex-col gap-3">
              <p className="text-14 text-muted-foreground">Give this temporary password to {name}. It is shown only once.</p>
              <SecretValue value={password} />
            </div>
          )}
        />
      );
    case "deactivate":
      return (
        <ActionForm
          user={user}
          action={setUserActive}
          onDone={onDone}
          danger
          confirmLabel="Deactivate"
          pendingLabel="Deactivating…"
          fields={<input type="hidden" name="active" value="false" />}
          description={
            <>
              {user.busy ? (
                <p>
                  <BusyWarning whose={whose} effect="Deactivating the account ends it mid-way." />
                </p>
              ) : null}
              <p>
                {name} is signed out everywhere, their workspace stops, and they can&apos;t sign in until you activate the
                account again. Their files are kept.
              </p>
            </>
          }
        />
      );
    case "activate":
      return (
        <ActionForm
          user={user}
          action={setUserActive}
          onDone={onDone}
          confirmLabel="Activate"
          pendingLabel="Activating…"
          fields={<input type="hidden" name="active" value="true" />}
          description={<p>{name} will be able to sign in again.</p>}
        />
      );
    case "delete":
      return <DeleteUserForm user={user} whose={whose} onDone={onDone} />;
  }
}

/** Deleting can't be undone, so the button stays disabled until the username is typed. */
function DeleteUserForm({ user, whose, onDone }: { user: DialogUser; whose: ReactNode; onDone: () => void }) {
  const [typed, setTyped] = useState("");
  return (
    <ActionForm
      user={user}
      action={deleteUser}
      onDone={onDone}
      danger
      confirmLabel="Delete user"
      pendingLabel="Deleting…"
      blocked={typed.trim().toLowerCase() !== user.username}
      description={
        <>
          {user.busy ? (
            <p>
              <BusyWarning whose={whose} effect="Deleting the user ends it mid-way." />
            </p>
          ) : null}
          <p>This permanently deletes {whose} account and every file in their workspace. This can&apos;t be undone.</p>
        </>
      }
      fields={
        <FormField
          label={`Type ${user.username} to confirm`}
          name="confirmUsername"
          placeholder={user.username}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      }
    />
  );
}

interface ActionFormProps {
  user: DialogUser;
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  /** Closes the dialog: after a success, or from Done once the password has been shown. */
  onDone: () => void;
  confirmLabel: string;
  pendingLabel: string;
  danger?: boolean;
  /** What the action does, as one or more paragraphs (the dialog's accessible description). */
  description: ReactNode;
  /** Extra form controls (hidden inputs, the delete confirmation field). */
  fields?: ReactNode;
  /** Disables the confirm button (e.g. until the username is typed). */
  blocked?: boolean;
  /** Shown instead of the form once the action returns a temporary password. */
  renderPassword?: (password: string) => ReactNode;
}

/** The confirmation form bound to one admin action: description, fields, error and the Cancel / confirm footer. */
function ActionForm(props: ActionFormProps) {
  const { user, action, onDone, confirmLabel, pendingLabel, danger, description, fields, blocked, renderPassword } = props;
  const [state, formAction] = useActionState(action, IDLE);
  const closeAfterSuccess = useEffectEvent(onDone);
  const password = state.status === "done" ? state.temporaryPassword : undefined;

  useEffect(() => {
    if (state.status === "done" && !state.temporaryPassword) closeAfterSuccess();
  }, [state]);

  if (password && renderPassword) {
    return (
      <AlertDialogBody>
        {renderPassword(password)}
        <AlertDialogFooter>
          <Button type="button" size="sm" className="min-w-16" autoFocus onClick={onDone}>
            Done
          </Button>
        </AlertDialogFooter>
      </AlertDialogBody>
    );
  }

  return (
    <form action={formAction}>
      <AlertDialogBody>
        <input type="hidden" name="userId" value={user.id} />
        <AlertDialogDescription asChild>
          <div className="flex flex-col gap-2">{description}</div>
        </AlertDialogDescription>
        {fields}
        {state.status === "error" ? <FormError>{state.message}</FormError> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <SubmitButton
            variant={danger ? "destructive" : "default"}
            size="sm"
            className="min-w-16"
            pendingLabel={pendingLabel}
            disabled={blocked}
          >
            {confirmLabel}
          </SubmitButton>
        </AlertDialogFooter>
      </AlertDialogBody>
    </form>
  );
}
