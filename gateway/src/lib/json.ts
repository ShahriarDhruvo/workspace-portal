/** The parsed JSON; null when the text isn't JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A record's field; undefined when `value` is not a record. */
export function field(value: unknown, name: string): unknown {
  return isRecord(value) ? value[name] : undefined;
}
