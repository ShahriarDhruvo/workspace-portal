import { displayName, type AgentKind, type User } from "@portal/core";
import { initials } from "./format";

/** The serializable slice of a user that client components get (never the password hash). */
export interface UserSummary {
  id: number;
  username: string;
  name: string;
  initials: string;
  role: User["role"];
  active: boolean;
  lastLoginAt: number | null;
  /** The harness chosen for the user's workspace (on Home, or by an administrator); null: the install's default. */
  agent: AgentKind | null;
}

export function toUserSummary(user: User): UserSummary {
  return {
    id: user.id,
    username: user.username,
    name: displayName(user),
    initials: initials(user.firstName, user.lastName),
    role: user.role,
    active: user.active,
    lastLoginAt: user.lastLoginAt,
    agent: user.agent,
  };
}
