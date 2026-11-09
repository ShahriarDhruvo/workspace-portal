// Input rules shared by the server actions, the admin seed and the forms.
// Pure module (no server-only imports) so it can be unit tested with `node --test`.
import { z } from "zod";
import { NAME_MAX_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, USERNAME_PATTERN } from "./limits.ts";

// Letters from any script (with combining marks), spaces, hyphens, straight and curly apostrophes, periods.
const NAME_PATTERN = /^[\p{L}\p{M} .'’-]+$/u;
const HAS_LETTER = /\p{L}/u;

export type FieldErrors = Partial<Record<string, string>>;

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

export const newUserSchema = profileSchema.extend({
  username: usernameSchema,
  password: newPasswordSchema,
});

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
