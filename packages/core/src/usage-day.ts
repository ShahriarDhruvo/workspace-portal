// The day key of llm_usage and host_daily, shared by the gateway that writes them and the web app that reads them:
// YYYY-MM-DD in the server's local time. Both run on the same host, so they agree.
export function usageDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
