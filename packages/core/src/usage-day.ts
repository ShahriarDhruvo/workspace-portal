// The llm_usage table's day key, shared by its writer (the gateway's LLM proxy) and its reader (Home's "usage
// today"): YYYY-MM-DD in the server's local time. The portal and the gateway run on the same host, so both agree.

/** YYYY-MM-DD in the local time zone. */
export function usageDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
