import { apiSession, json, jsonError } from "@/lib/api";
import { getDb } from "@/lib/db";
import { isMonth, loadEnergyMonth } from "@/lib/energy";

export const dynamic = "force-dynamic";

/**
 * Admin > Usage's energy card: a month of both servers' energy and cost (?month=YYYY-MM, the current month without
 * one), today so far and the prices. Polled every 60 s while the page is visible, and on a change of month.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await apiSession({ admin: true });
  if (session instanceof Response) return session;
  const month = new URL(request.url).searchParams.get("month");
  if (month !== null && !isMonth(month)) return jsonError(400, "bad_month", "The month must be written as YYYY-MM.");
  return json(loadEnergyMonth(getDb(), month));
}
