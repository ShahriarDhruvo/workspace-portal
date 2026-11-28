import { route } from "@/lib/api";
import { loadUsageToday } from "@/lib/usage";

export const dynamic = "force-dynamic";

/** The signed-in user's requests and tokens so far today, for Home's usage card. */
export const GET = route({}, (session) => loadUsageToday(session.user.id));
