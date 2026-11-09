// Creates the admin account on first start. Takes the database and the settings as arguments (no
// server-only imports) so it can be unit tested; startup.ts passes getDb() and adminSeedSettings().
import { eq } from "drizzle-orm";
import { users, writeAudit, type PortalDb } from "@portal/db";
import { hashPassword } from "./passwords.ts";
import { newUserSchema } from "./validation.ts";

/** The ADMIN_* settings (config.ts `adminSeedSettings`). */
export interface AdminSeedSettings {
  username: string;
  password: string;
  firstName: string;
  middleName: string;
  lastName: string;
}

/**
 * Creates the single admin account from ADMIN_* settings if no admin exists. Never touches an existing admin.
 * The admin must choose a new password at the first sign-in: ADMIN_PASSWORD sits in .env in plain text.
 */
export async function seedAdmin(db: PortalDb, settings: AdminSeedSettings): Promise<void> {
  const hasAdmin = db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).get();
  if (hasAdmin) return;

  if (!settings.password) {
    console.error(
      "[seed] No admin account exists and ADMIN_PASSWORD is empty, so none was created. " +
        "Set ADMIN_PASSWORD (and optionally ADMIN_USERNAME, ADMIN_FIRST_NAME, ADMIN_MIDDLE_NAME, ADMIN_LAST_NAME) and restart.",
    );
    return;
  }

  const parsed = newUserSchema.safeParse(settings);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${String(issue.path[0])}: ${issue.message}`).join("; ");
    console.error(`[seed] Cannot create the admin account from the ADMIN_* settings: ${problems}`);
    return;
  }

  const { username, password, firstName, middleName, lastName } = parsed.data;
  const passwordHash = await hashPassword(password);
  const now = Date.now();
  try {
    // Synchronous better-sqlite3 transaction: statements through `db` inside it are part of it.
    db.transaction(() => {
      const admin = db
        .insert(users)
        .values({
          username,
          firstName,
          middleName,
          lastName,
          passwordHash,
          role: "admin",
          mustChangePassword: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: users.id })
        .get();
      writeAudit(db, {
        action: "user_created",
        targetUserId: admin.id,
        details: { username, role: "admin", source: "seed" },
      });
    });
    console.log(`[seed] Created the admin account "${username}".`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("users.role")) return; // Another process created the admin at the same moment.
    if (message.includes("users.username")) {
      console.error(`[seed] Cannot create the admin account: the username "${username}" belongs to an existing user.`);
      return;
    }
    throw error;
  }
}
