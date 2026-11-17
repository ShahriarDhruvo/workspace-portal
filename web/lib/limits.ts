// Input limits shared by the zod schemas and the forms (kept apart so client bundles don't pull in zod).
export const NAME_MAX_LENGTH = 50;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
