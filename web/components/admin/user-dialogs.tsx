"use client";

import { useActionState, useEffect, useEffectEvent, useState, type ReactNode } from "react";
import {
  deleteUser,
  resetPassword,
  setUserActive,
  stopWorkspace,
  type ActionState,
} from "@/lib/actions/admin";
import { buttonClass } from "@/components/ui/button";
import { SecretValue } from "@/components/ui/copy-button";
import { Dialog, DialogFooter } from "@/components/ui/dialog";
import { Field, FormError } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { BusyWarning } from "@/components/workspace/busy-warning";

export type UserDialogKind = "stop" | "reset" | "deactivate" | "activate" | "delete";

export interface DialogUser {
  id: number;
  name: string;
  username: string;
  /** The user's agent is working right now (the dialogs that stop the workspace at once warn). */
  busy?: boolean;
}

const IDLE: ActionState = { status: "idle" };

interface ActionDialogProps {
  title: string;
  user: DialogUser;
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  onClose: () => void;
  confirmLabel: string;
  pendingLabel: string;
  danger?: boolean;
  description: ReactNode;
  /** Extra form controls (hidden inputs, the delete confirmation field). */
  fields?: ReactNode;
  /** Disables the confirm button (e.g. until the username is typed). */
  blocked?: boolean;
  /** Shown instead of the form once the action returns a temporary password. */
  renderPassword?: (password: string) => ReactNode;
}

/** Confirm dialog bound to one admin action. Closes itself on success unless there is a password to show. */
function ActionDialog(props: ActionDialogProps) {
  const { title, user, action, onClose, confirmLabel, pendingLabel, danger, description, fields, blocked } = props;
  const [state, formAction] = useActionState(action, IDLE);
  const closeAfterSuccess = useEffectEvent(onClose);
  const password = state.status === "done" ? state.temporaryPassword : undefined;

  useEffect(() => {
    if (state.status === "done" && !state.temporaryPassword) closeAfterSuccess();
  }, [state]);

  return (
    <Dialog title={title} onClose={onClose}>
      {password && props.renderPassword ? (
        <>
          {props.renderPassword(password)}
          <DialogFooter>
            <button type="button" className={buttonClass("primary", "sm", "min-w-16")} onClick={onClose}>
              Done
            </button>
          </DialogFooter>
        </>
      ) : (
        <form action={formAction} className="flex flex-col gap-4">
          <input type="hidden" name="userId" value={user.id} />
          <div className="text-14 text-fg-muted">{description}</div>
          {fields}
          {state.status === "error" ? <FormError>{state.message}</FormError> : null}
          <DialogFooter>
            <button type="button" className={buttonClass("outline", "sm")} onClick={onClose}>
              Cancel
            </button>
            <SubmitButton variant={danger ? "danger" : "primary"} size="sm" className="min-w-16" pendingLabel={pendingLabel} disabled={blocked}>
              {confirmLabel}
            </SubmitButton>
          </DialogFooter>
        </form>
      )}
    </Dialog>
  );
}

function DeleteUserDialog({ user, name, onClose }: { user: DialogUser; name: ReactNode; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  return (
    <ActionDialog
      title="Delete user"
      user={user}
      action={deleteUser}
      onClose={onClose}
      danger
      confirmLabel="Delete user"
      pendingLabel="Deleting…"
      blocked={typed.trim().toLowerCase() !== user.username}
      description={
        <>
          {user.busy ? (
            <p className="mb-2">
              <BusyWarning whose={<>{name}&apos;s</>} effect="Deleting the user ends it mid-way." />
            </p>
          ) : null}
          <p>
            This permanently deletes {name}&apos;s account and every file in their workspace. This can&apos;t be undone.
          </p>
        </>
      }
      fields={
        <Field
          label={`Type ${user.username} to confirm`}
          name="confirmUsername"
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

/** One admin action on one user, as a confirm dialog. Mount to open; `onClose` should unmount it. */
export function UserDialog({ kind, user, onClose }: { kind: UserDialogKind; user: DialogUser; onClose: () => void }) {
  const name = <strong className="font-medium text-fg">{user.name}</strong>;
  switch (kind) {
    case "stop":
      return (
        <ActionDialog
          title="Stop workspace"
          user={user}
          action={stopWorkspace}
          onClose={onClose}
          confirmLabel="Stop"
          pendingLabel="Stopping…"
          description={
            user.busy ? (
              <BusyWarning whose={<>{name}&apos;s</>} effect="Stopping ends it mid-way; files written so far are kept. Stop anyway?" />
            ) : (
              <>
                Stop {name}&apos;s workspace now? Anything running in it ends; files are kept. It starts again the next
                time it&apos;s opened.
              </>
            )
          }
        />
      );
    case "reset":
      return (
        <ActionDialog
          title="Reset password"
          user={user}
          action={resetPassword}
          onClose={onClose}
          confirmLabel="Reset password"
          pendingLabel="Resetting…"
          description={
            <>
              {name} is signed out everywhere and gets a new temporary password, which they must change at their next
              sign-in.
            </>
          }
          renderPassword={(password) => (
            <div className="flex flex-col gap-3">
              <p className="text-14 text-fg-muted">
                Give this temporary password to {name}. It is shown only once.
              </p>
              <SecretValue value={password} />
            </div>
          )}
        />
      );
    case "deactivate":
      return (
        <ActionDialog
          title="Deactivate user"
          user={user}
          action={setUserActive}
          onClose={onClose}
          danger
          confirmLabel="Deactivate"
          pendingLabel="Deactivating…"
          fields={<input type="hidden" name="active" value="false" />}
          description={
            <>
              {user.busy ? (
                <p className="mb-2">
                  <BusyWarning whose={<>{name}&apos;s</>} effect="Deactivating the account ends it mid-way." />
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
        <ActionDialog
          title="Activate user"
          user={user}
          action={setUserActive}
          onClose={onClose}
          confirmLabel="Activate"
          pendingLabel="Activating…"
          fields={<input type="hidden" name="active" value="true" />}
          description={<>{name} will be able to sign in again.</>}
        />
      );
    case "delete":
      return <DeleteUserDialog user={user} name={name} onClose={onClose} />;
  }
}

/** A button that opens one of the user dialogs (used on the user detail page). */
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
  return (
    <>
      <button type="button" className={buttonClass(danger ? "danger-outline" : "outline", "sm")} onClick={() => setOpen(true)}>
        {children}
      </button>
      {open ? <UserDialog kind={kind} user={user} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
