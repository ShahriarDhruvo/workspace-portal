"use server";

import { requireUser } from "../session";
import { saveHarnessOf } from "../harness";
import { saveProfile, type ProfileState } from "../profile";
import type { ActionResult } from "../validation";

// The signed-in user's own settings: the account's on /settings, the harness on Home. They are about the user's own
// account and workspace, also for an administrator whose session is viewing someone else's.

/** Saves the user's own name (the Account card). */
export async function saveName(_previous: ProfileState, formData: FormData): Promise<ProfileState> {
  const { user } = await requireUser();
  return saveProfile(user.id, user, formData);
}

/** Saves the harness the user's own workspace starts with, picked on Home (lib/harness.ts). */
export async function saveHarness(agent: string): Promise<ActionResult> {
  const { user } = await requireUser();
  return saveHarnessOf(user, agent, user.id);
}
