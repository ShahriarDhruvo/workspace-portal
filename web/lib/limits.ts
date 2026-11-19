// Input limits shared by the zod schemas and the forms (kept apart so client bundles don't pull in zod).
export const NAME_MAX_LENGTH = 50;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
/** Working API keys a user may have at once (the API page). */
export const MAX_API_KEYS = 5;
export const API_KEY_NAME_MAX_LENGTH = 40;
/** The largest request body the LLM API passes on (app/llm/api): the LLM server's own limit (llm-server/gufo.container). */
export const LLM_API_BODY_BYTES = 64 * 1024 * 1024;
