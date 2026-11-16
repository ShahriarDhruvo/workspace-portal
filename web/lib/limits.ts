// Input limits shared by the zod schemas and the forms (kept apart so client bundles don't pull in zod).
export const NAME_MAX_LENGTH = 50;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** Agent versions as the gateway accepts them (gateway/src/versions.ts): 0.27.4, 0.2.2-rc.3. */
const AGENT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?$/;
/** An image tag holds at most 128 characters, `<agent>-` included. */
const AGENT_VERSION_MAX_LENGTH = 100;

/** An exact agent version (never an npm dist-tag such as "latest"): the update schema's rule. */
export const isAgentVersion = (value: string): boolean =>
  value.length <= AGENT_VERSION_MAX_LENGTH && AGENT_VERSION_PATTERN.test(value);
