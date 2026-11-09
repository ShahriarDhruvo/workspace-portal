"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { AgentKind } from "@portal/db";
import { fetchJson } from "@/lib/fetch-json";
import { agentLabel, summarizeWorkspace } from "@/lib/format";
import type { AdminOverview, WorkspaceInfo } from "@/lib/gateway-types";
import type { UserSummary } from "@/lib/user-summary";
import { Avatar } from "@/components/brand";
import { LocalTime } from "@/components/local-time";
import { EditIcon, KeyIcon, StopIcon, TrashIcon, UserCheckIcon, UserXIcon } from "@/components/ui/icons";
import { Menu, MenuItem, MenuLink, MenuSeparator } from "@/components/ui/menu";
import { TABLE_CLASS, TABLE_SHELL_CLASS, TD_CLASS, TH_CLASS, TR_CLASS } from "@/components/ui/table";
import { StatusDot, Tag } from "@/components/ui/tag";
import { HostStats } from "./host-stats";
import { OpenWorkspaceForm } from "./open-workspace-form";
import { UserDialog, type UserDialogKind } from "./user-dialogs";

const REFRESH_MS = 5_000;

interface DashboardProps {
  users: UserSummary[];
  initialOverview: AdminOverview;
  currentAdminId: number;
  idleTimeoutMinutes: number;
  /** AGENT_NAMES, which this client component can't import from @portal/db. */
  agentNames: Readonly<Record<AgentKind, string>>;
}

/** Host stats and the users table, with workspace state refreshed every 5 s. */
export function AdminDashboard({ users, initialOverview, currentAdminId, idleTimeoutMinutes, agentNames }: DashboardProps) {
  const router = useRouter();
  const [overview, setOverview] = useState(initialOverview);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setInterval(async () => {
      const result = await fetchJson<AdminOverview>("/api/admin/overview", { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok) setOverview(result.data);
      else if (result.status === 401 || result.status === 403) router.refresh();
      else setOverview((current) => ({ ...current, error: result.error }));
    }, REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [router]);

  const workspaces = new Map((overview.workspaces ?? []).map((info) => [info.userId, info]));

  return (
    <div className="flex flex-col gap-6">
      {overview.error ? (
        <section role="alert" aria-label="Issues" className="rounded-xl border border-line-soft px-3.5 py-2.5">
          <h2 className="label-caps mb-2">Issues</h2>
          <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <Tag tone="warning">Warning</Tag>
            <span>Workspace service unavailable: {overview.error.message} Workspace status may be out of date.</span>
          </p>
        </section>
      ) : null}
      <section aria-labelledby="host-heading" className="flex flex-col gap-2">
        <h2 id="host-heading" className="label-caps">
          Host
        </h2>
        <HostStats stats={overview.stats} />
      </section>
      <section aria-labelledby="users-heading" className="flex flex-col gap-2">
        <h2 id="users-heading" className="label-caps">
          Users <span className="tabular-nums">({users.length})</span>
        </h2>
        <div className={TABLE_SHELL_CLASS}>
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                {["Name", "Username", "Role", "Account", "Workspace", "Agent", "Last sign-in"].map((heading) => (
                  <th key={heading} scope="col" className={TH_CLASS}>
                    {heading}
                  </th>
                ))}
                <th scope="col" className={TH_CLASS}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  isSelf={user.id === currentAdminId}
                  workspace={overview.workspaces ? (workspaces.get(user.id) ?? null) : undefined}
                  idleTimeoutMinutes={idleTimeoutMinutes}
                  agentNames={agentNames}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

interface UserRowProps {
  user: UserSummary;
  isSelf: boolean;
  /** undefined = unknown (gateway unavailable); null = no workspace row (stopped). */
  workspace: WorkspaceInfo | null | undefined;
  idleTimeoutMinutes: number;
  agentNames: Readonly<Record<AgentKind, string>>;
}

function UserRow({ user, isSelf, workspace, idleTimeoutMinutes, agentNames }: UserRowProps) {
  const [dialog, setDialog] = useState<UserDialogKind | null>(null);
  const summary = workspace === undefined ? null : summarizeWorkspace(workspace, idleTimeoutMinutes);
  const running = workspace?.status === "running" || workspace?.status === "starting";
  const agent = workspace ? agentLabel(workspace, agentNames) : null;
  const cell = TD_CLASS;

  return (
    <tr className={TR_CLASS}>
      <td className={cell}>
        <Link href={`/admin/users/${user.id}`} className="flex min-w-0 items-center gap-2 rounded-sm font-medium text-fg">
          <Avatar initials={user.initials} />
          <span className="truncate">{user.name}</span>
          {isSelf ? <Tag tone="outline">You</Tag> : null}
        </Link>
      </td>
      <td className={`${cell} text-fg-muted`}>{user.username}</td>
      <td className={cell}>{user.role === "admin" ? <Tag tone="solid">Admin</Tag> : <Tag tone="outline">User</Tag>}</td>
      <td className={cell}>
        {user.active ? <Tag tone="success">Active</Tag> : <Tag tone="neutral">Disabled</Tag>}
      </td>
      <td className={`${cell} whitespace-nowrap`} title={summary?.title ?? undefined}>
        {summary ? (
          <span className="flex items-center gap-1.5">
            <StatusDot tone={summary.tone} pulse={summary.label === "Working"} />
            <span className="text-fg">{summary.label}</span>
            {summary.detail ? <span className="text-fg-muted">· {summary.detail}</span> : null}
          </span>
        ) : (
          <span className="text-fg-muted">Unknown</span>
        )}
      </td>
      <td className={`${cell} whitespace-nowrap ${running ? "text-fg" : "text-fg-muted"}`}>{agent ?? "—"}</td>
      <td className={`${cell} whitespace-nowrap text-fg-muted`}>
        {user.lastLoginAt ? <LocalTime at={user.lastLoginAt} relative /> : <span className="text-fg-muted">Never</span>}
      </td>
      <td className={`${cell} w-0`}>
        <div className="flex items-center justify-end gap-1">
          <OpenWorkspaceForm userId={user.id} label="Open" />
          <Menu label={`Actions for ${user.name}`}>
            <MenuItem icon={<StopIcon />} onSelect={() => setDialog("stop")} disabled={!running}>
              Stop workspace
            </MenuItem>
            <MenuLink icon={<EditIcon />} href={`/admin/users/${user.id}`}>
              Edit
            </MenuLink>
            {isSelf ? (
              <MenuLink icon={<KeyIcon />} href="/change-password">
                Change password
              </MenuLink>
            ) : (
              <>
                <MenuItem icon={<KeyIcon />} onSelect={() => setDialog("reset")}>
                  Reset password…
                </MenuItem>
                {user.active ? (
                  <MenuItem icon={<UserXIcon />} onSelect={() => setDialog("deactivate")}>
                    Deactivate…
                  </MenuItem>
                ) : (
                  <MenuItem icon={<UserCheckIcon />} onSelect={() => setDialog("activate")}>
                    Activate…
                  </MenuItem>
                )}
                <MenuSeparator />
                <MenuItem icon={<TrashIcon />} tone="danger" onSelect={() => setDialog("delete")}>
                  Delete…
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
        {dialog ? (
          <UserDialog kind={dialog} user={{ ...user, busy: workspace?.busy ?? false }} onClose={() => setDialog(null)} />
        ) : null}
      </td>
    </tr>
  );
}
