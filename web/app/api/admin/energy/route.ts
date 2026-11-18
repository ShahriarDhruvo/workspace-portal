import { jsonError, route } from "@/lib/api";
import { getDb } from "@/lib/db";
import { isMonth, loadEnergyMonth } from "@/lib/energy";

export const dynamic = "force-dynamic";

/** Admin > Energy: a month of both servers' energy and cost (?month=YYYY-MM, else the current one), today so far and the prices. */
export const GET = route({ admin: true }, (_session, request) => {
  const month = new URL(request.url).searchParams.get("month");
  if (month !== null && !isMonth(month)) return jsonError(400, "bad_month", "The month must be written as YYYY-MM.");
  return loadEnergyMonth(getDb(), month);
});
