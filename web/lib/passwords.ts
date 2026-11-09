// Password hashing with argon2id. @node-rs/argon2's defaults are Argon2id, m=19456 KiB, t=2, p=1
// (the OWASP baseline); passwords.test.ts pins that the output really is argon2id.
import { randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies a password. With no stored hash (unknown username) it still runs a full verification
 * against a throwaway hash, so response timing does not reveal which usernames exist.
 */
export async function verifyPassword(storedHash: string | null, password: string): Promise<boolean> {
  const target = storedHash ?? (await (dummyHash ??= hash(randomBytes(32).toString("base64url"))));
  try {
    const matches = await verify(target, password);
    return matches && storedHash !== null;
  } catch {
    return false;
  }
}
