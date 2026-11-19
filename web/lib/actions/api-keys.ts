"use server";

import { refresh } from "next/cache";
import { createApiKey, revokeApiKey } from "../api-keys";
import { getDb } from "../db";
import { API_KEY_NAME_MAX_LENGTH, MAX_API_KEYS } from "../limits";
import { requireUser } from "../session";
import { normalizeName, type ActionResult } from "../validation";

// The signed-in user's own API keys (/api-keys), also for an administrator whose session is viewing someone else's.

export type CreateKeyState = { status: "idle" } | { status: "error"; message: string } | { status: "done"; key: string };

/** Creates a key with the form's name and answers the key itself, which can't be read again. */
export async function createKey(_previous: CreateKeyState, formData: FormData): Promise<CreateKeyState> {
  const { user } = await requireUser();
  const name = normalizeName(String(formData.get("name") ?? ""));
  if (name === "" || name.length > API_KEY_NAME_MAX_LENGTH) return { status: "error", message: `Give the key a name of up to ${API_KEY_NAME_MAX_LENGTH} characters.` };
  const key = createApiKey(getDb(), user.id, name);
  if (key === null) return { status: "error", message: `You already have ${MAX_API_KEYS} keys. Revoke one first.` };
  refresh();
  return { status: "done", key };
}

export async function revokeKey(keyId: number): Promise<ActionResult> {
  const { user } = await requireUser();
  if (!revokeApiKey(getDb(), user.id, keyId)) return { ok: false, message: "That key is already revoked." };
  refresh();
  return { ok: true };
}
