import { route } from "@/lib/api";
import { gateway } from "@/lib/gateway";
import { loaded } from "@/lib/overview";

export const dynamic = "force-dynamic";

/** The other software on the AI server, its versions and update job, for the Updates page. */
export const GET = route({ admin: true }, () => loaded(gateway.apps()));

/** "Check for updates": the same answer, after the gateway asked GitHub and the image registry again. */
export const POST = route({ admin: true }, () => loaded(gateway.apps({ refresh: true })));
