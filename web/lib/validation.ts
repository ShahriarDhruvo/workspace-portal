// Input rules shared by the server actions, the admin seed and the forms (no server-only imports).
import { z } from "zod";
import { AGENT_KINDS, isVersion, WORKSPACE_KINDS } from "@portal/core";
import { NAME_MAX_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, USERNAME_PATTERN } from "./limits.ts";

// Letters from any script (with combining marks), spaces, hyphens, straight and curly apostrophes, periods.
const NAME_PATTERN = /^[\p{L}\p{M} .'’-]+$/u;
const HAS_LETTER = /\p{L}/u;

export type FieldErrors = Partial<Record<string, string>>;

/** What a server action without a form answers: done, or why not. */
export type ActionResult = { ok: true } | { ok: false; message: string };

/** NFC-normalizes, trims and collapses runs of whitespace into single spaces. */
export function normalizeName(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

/** Returns why a (normalized) name is invalid, or null if it is fine. */
function nameProblem(value: string, label: string): string | null {
  if (value.length === 0) return `Enter a ${label}.`;
  if ([...value].length > NAME_MAX_LENGTH) return `Use at most ${NAME_MAX_LENGTH} characters.`;
  if (!NAME_PATTERN.test(value) || !HAS_LETTER.test(value)) {
    return "Use letters, spaces, hyphens, apostrophes and periods only.";
  }
  return null;
}

function requiredName(label: string) {
  return z
    .string()
    .transform(normalizeName)
    .superRefine((value, ctx) => {
      const problem = nameProblem(value, label);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    });
}

function optionalName(label: string) {
  return z
    .string()
    .transform(normalizeName)
    .superRefine((value, ctx) => {
      const problem = value === "" ? null : nameProblem(value, label);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    })
    .transform((value) => (value === "" ? null : value));
}

export const usernameSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(
    z
      .string()
      .regex(
        USERNAME_PATTERN,
        "Use 3–32 lowercase letters, digits, dots, hyphens or underscores, starting with a letter or digit.",
      ),
  );

export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`);

export const profileSchema = z.object({
  firstName: requiredName("first name"),
  middleName: optionalName("middle name"),
  lastName: requiredName("last name"),
});

/** A checkbox or switch in a form: "on" when checked, absent (formText: "") when not. */
const checkboxSchema = z.string().transform((value) => value === "on");

/** A new account: names, username and (temporary) password. Also the admin seed's ADMIN_* settings. */
export const newUserSchema = profileSchema.extend({
  username: usernameSchema,
  password: newPasswordSchema,
});

/** The New user form: a new account plus its "Online workspace" permission. */
export const newUserFormSchema = newUserSchema.extend({ onlineAllowed: checkboxSchema });

export const loginSchema = z.object({
  username: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(z.string().min(1).max(64)),
  password: z.string().min(1).max(1024),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    newPassword: newPasswordSchema,
    confirmPassword: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.confirmPassword !== value.newPassword) {
      ctx.addIssue({ code: "custom", path: ["confirmPassword"], message: "The passwords don't match." });
    }
    if (value.newPassword === value.currentPassword) {
      ctx.addIssue({
        code: "custom",
        path: ["newPassword"],
        message: "Choose a password that differs from the current one.",
      });
    }
  });

export const userIdSchema = z.coerce.number().int().positive();

const agentKindSchema = z.enum(AGENT_KINDS, "Unknown agent.");

const workspaceKindSchema = z.enum(WORKSPACE_KINDS, "Choose Private or Online.");

/**
 * POST /api/workspace/start: the kind the person chose and confirmed. Required: nothing starts a workspace without
 * that choice (the gateway would start Private).
 */
export const workspaceStartSchema = z.object({ kind: workspaceKindSchema });

/** The admin's per-user Online permission (the user page's switch). */
export const onlineAccessSchema = z.object({
  userId: userIdSchema,
  allowed: z.enum(["true", "false"]).transform((value) => value === "true"),
});

/** Erasing one kind's files (the user page's "Erase Private files…" / "Erase Online files…"). */
export const eraseFilesSchema = z.object({ userId: userIdSchema, kind: workspaceKindSchema });

/** A harness choice in Settings: an agent kind. Whether this install enables it is the action's check. */
export const harnessSchema = z.object({ agent: agentKindSchema });

/** Said for a missing or malformed version, empty included. */
const AGENT_VERSION_ERROR = "Enter a version like 0.27.4.";

/** The agent and version of one of its images. */
export const agentImageSchema = z.object({
  agent: agentKindSchema,
  version: z
    .string()
    .trim()
    .refine(isVersion, AGENT_VERSION_ERROR),
});

/**
 * An update: the exact version to install (a Package images row's) and whether to build from scratch. Never an npm
 * dist-tag ("latest"), which could name a newer version than the one the admin saw and confirmed.
 */
export const agentUpdateSchema = agentImageSchema.extend({
  rebuild: z.boolean(),
});

/** The first message for each top-level field. */
export function fieldErrors(error: z.ZodError): FieldErrors {
  const result: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    result[key] ??= issue.message;
  }
  return result;
}

/** Reads string fields from FormData; missing or non-string entries become "". */
export function formText<K extends string>(formData: FormData, keys: readonly K[]): Record<K, string> {
  const result = {} as Record<K, string>;
  for (const key of keys) {
    const value = formData.get(key);
    result[key] = typeof value === "string" ? value : "";
  }
  return result;
}
