import { route } from "@/lib/api";
import { gateway } from "@/lib/gateway";
import { loaded } from "@/lib/overview";

export const dynamic = "force-dynamic";

/** The agents' versions and the update job for the Updates page. */
export const GET = route({ admin: true }, () => loaded(gateway.agentVersions()));

/** "Check for updates": the same answer, after the gateway asked the npm registry (and GitHub) again. */
export const POST = route({ admin: true }, () => loaded(gateway.agentVersions({ refresh: true })));
