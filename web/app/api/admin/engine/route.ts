import { route } from "@/lib/api";
import { gateway } from "@/lib/gateway";
import { loaded } from "@/lib/overview";

export const dynamic = "force-dynamic";

/** The LLM engine's versions and update job for the Updates page. */
export const GET = route({ admin: true }, () => loaded(gateway.engine()));

/** "Check for updates": the same answer, after the gateway asked the image registry and GitHub again. */
export const POST = route({ admin: true }, () => loaded(gateway.engine({ refresh: true })));
