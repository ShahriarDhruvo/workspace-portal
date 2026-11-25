// What a workspace's agent is told of its person and the portal's place (harnesses/instructions.ts): read at every
// start, so a changed name or place applies at the next one.
import { eq } from "drizzle-orm";
import { displayName, energyLocation, energyLocationLabel, readSetting, users, type PortalDb, type WorkspaceKind } from "@portal/core";
import type { WorkspaceFacts } from "@portal/harnesses";

/** The place is the one the admin picked in Settings for the electricity price: the portal has no other. */
export function workspaceFacts(db: PortalDb, userId: number, kind: WorkspaceKind): WorkspaceFacts {
  const user = db.select({ firstName: users.firstName, middleName: users.middleName, lastName: users.lastName }).from(users).where(eq(users.id, userId)).get();
  if (!user) throw new Error(`user ${userId} does not exist`);
  const place = energyLocation(readSetting(db, "energy_price_location"));
  return { kind, person: displayName(user), place: place ? energyLocationLabel(place) : null };
}
