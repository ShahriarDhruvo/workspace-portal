import "server-only";
import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { users, writeAudit, type User } from "@portal/core";
import { getDb } from "./db";
import { fieldErrors, formText, profileSchema, type FieldErrors } from "./validation";

const NAME_FIELDS = ["firstName", "middleName", "lastName"] as const;

export type ProfileState =
  | { status: "idle" }
  | { status: "invalid"; fieldErrors: FieldErrors; values: Record<(typeof NAME_FIELDS)[number], string> }
  | { status: "error"; message: string }
  | { status: "saved"; at: number };

/**
 * Saves `user`'s name from the Profile form (an admin's for any user, Settings' for one's own). Audited as
 * `user_updated` by `actorUserId`, with the fields that changed; an unchanged name stores nothing.
 */
export function saveProfile(actorUserId: number, user: User, formData: FormData): ProfileState {
  const values = formText(formData, NAME_FIELDS);
  const parsed = profileSchema.safeParse(values);
  if (!parsed.success) return { status: "invalid", fieldErrors: fieldErrors(parsed.error), values };
  const changes: Record<string, { from: string | null; to: string | null }> = {};
  for (const key of NAME_FIELDS) {
    if ((user[key] ?? null) !== parsed.data[key]) changes[key] = { from: user[key] ?? null, to: parsed.data[key] };
  }
  if (Object.keys(changes).length > 0) {
    const db = getDb();
    db.transaction(() => {
      db.update(users)
        .set({ ...parsed.data, updatedAt: Date.now() })
        .where(eq(users.id, user.id))
        .run();
      writeAudit(db, { action: "user_updated", actorUserId, targetUserId: user.id, details: changes });
    });
    refresh();
  }
  return { status: "saved", at: Date.now() };
}
