"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { AGENT_NAMES, type AgentKind, type WorkspaceInfo } from "@portal/core/wire";
import { startingAgent } from "@/lib/agent-choice";
import { agentLabel, formatVersion } from "@/lib/format";
import type { AdminOverview } from "@/lib/overview";
import type { UserSummary } from "@/lib/user-summary";
import { UserAvatar } from "@/components/brand";
import { LocalTime } from "@/components/local-time";
import { DataTable, DataTableHead, DataTablePagination, usePagination } from "@/components/common/data-table";
import { usePoll } from "@/components/common/use-poll";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EditIcon, EllipsisIcon, KeyIcon, StopIcon, TrashIcon, UserCheckIcon, UserXIcon } from "@/components/ui/icons";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { OpenWorkspaceForm } from "./open-workspace-form";
import { ServiceIssue } from "./service-issue";
import { UserDialog, type DialogUser, type UserDialogKind } from "./user-dialogs";
import { WorkspacesCard } from "./workspaces-card";

const REFRESH_MS = 5_000;

interface DashboardProps {
  users: UserSummary[];
  initialOverview: AdminOverview;
  currentAdminId: number;
  /** The enabled agents in display order; null when the gateway can't say. */
  enabledAgents: ReadonlyArray<{ id: AgentKind }> | null;
}

/**
 * The users table, 30 to a page, over the running workspaces (who, kind, harness, status, what it uses), both
 * refreshed every 5 s from the workspace list. Without the gateway the workspaces card is left out.
 */
export function UsersDashboard({ users, initialOverview, currentAdminId, enabledAgents }: DashboardProps) {
  const [overview, setOverview] = useState(initialOverview);
  usePoll<AdminOverview>("/api/admin/overview", REFRESH_MS, (result) =>
    setOverview((current) => (result.ok ? result.data : { ...current, error: result.error })),
  );

  const workspaces = new Map((overview.workspaces ?? []).map((info) => [info.userId, info]));
  const names = new Map(users.map((user) => [user.id, user.name]));
  const { rows, pagination } = usePagination(users);

  return (
    <>
      {overview.error ? <ServiceIssue message={overview.error.message}>Workspace status may be out of date.</ServiceIssue> : null}
      <DataTable footer={<DataTablePagination {...pagination} label="Users pages" />} tableProps={{ "aria-label": "Users" }}>
        <TableHeader>
          <TableRow>
            {["Name", "Username", "Role", "Account", "Harness", "Last sign-in"].map((heading) => (
              <DataTableHead key={heading}>{heading}</DataTableHead>
            ))}
            <DataTableHead>
              <span className="sr-only">Actions</span>
            </DataTableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              isSelf={user.id === currentAdminId}
              workspace={overview.workspaces ? (workspaces.get(user.id) ?? null) : undefined}
              nextAgent={enabledAgents ? startingAgent(user.agent, enabledAgents) : user.agent}
            />
          ))}
        </TableBody>
      </DataTable>
      {overview.workspaces ? (
        <WorkspacesCard
          workspaces={overview.workspaces}
          names={names}
          maxRunning={overview.stats?.maxRunning ?? null}
          now={overview.t}
        />
      ) : null}
    </>
  );
}

interface UserRowProps {
  user: UserSummary;
  isSelf: boolean;
  /** undefined = unknown (gateway unavailable); null = no workspace row (stopped). */
  workspace: WorkspaceInfo | null | undefined;
  /** The harness the workspace starts with next (the saved choice while enabled, else the default). */
  nextAgent: AgentKind | null;
}

function UserRow({ user, isSelf, workspace, nextAgent }: UserRowProps) {
  const running = workspace?.status === "running" || workspace?.status === "starting";
  // A running workspace shows its agent and version; a stopped one, the harness it starts with next.
  const agent = running && workspace ? agentLabel(workspace) : nextAgent ? AGENT_NAMES[nextAgent] : null;

  return (
    <TableRow>
      <TableCell>
        {/* A long name is cut short (in full in its tooltip) rather than widening the table. */}
        <Link
          href={`/admin/users/${user.id}`}
          className="hit-area relative flex min-w-0 items-center gap-2 rounded-sm font-medium text-foreground"
        >
          <UserAvatar initials={user.initials} />
          <span className="max-w-56 truncate" title={user.name}>
            {user.name}
          </span>
          {isSelf ? <Badge variant="outline">You</Badge> : null}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {user.username}
      </TableCell>
      <TableCell>{user.role === "admin" ? <Badge>Admin</Badge> : <Badge variant="outline">User</Badge>}</TableCell>
      <TableCell>
        {user.active ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Deactivated</Badge>}
      </TableCell>
      <TableCell
        className={running ? "text-foreground" : "text-muted-foreground"}
        title={running ? undefined : user.agent ? "Chosen in Settings; starts with the next Start" : "The default; starts with the next Start"}
      >
        <span className="flex items-baseline gap-x-1.5">
          <span>{agent ?? "—"}</span>
          {agent && running && workspace?.agentVersion ? (
            <span className="font-mono text-12 text-muted-foreground">{formatVersion(workspace.agentVersion)}</span>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {user.lastLoginAt ? <LocalTime at={user.lastLoginAt} relative /> : "Never"}
      </TableCell>
      <TableCell className="w-0">
        <div className="flex items-center justify-end gap-1 pointer-coarse:gap-2">
          <OpenWorkspaceForm userId={user.id} />
          <UserActions user={{ ...user, busy: workspace?.busy ?? false }} isSelf={isSelf} running={running} active={user.active} />
        </div>
      </TableCell>
    </TableRow>
  );
}

/** The row's "…" menu and the confirmation dialog its items open; closing the dialog refocuses the "…" button. */
function UserActions({ user, isSelf, running, active }: { user: DialogUser; isSelf: boolean; running: boolean; active: boolean }) {
  const [dialog, setDialog] = useState<UserDialogKind>("stop");
  const [dialogOpen, setDialogOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function openDialog(kind: UserDialogKind) {
    setDialog(kind);
    setDialogOpen(true);
  }

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button ref={triggerRef} type="button" variant="ghost" size="icon-sm" aria-label={`Actions for ${user.name}`}>
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" collisionPadding={8} className="w-auto min-w-40">
          <DropdownMenuItem disabled={!running} onSelect={() => openDialog("stop")}>
            <StopIcon />
            Stop workspace…
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/admin/users/${user.id}`}>
              <EditIcon />
              Edit
            </Link>
          </DropdownMenuItem>
          {isSelf ? (
            <DropdownMenuItem asChild>
              <Link href="/settings#password">
                <KeyIcon />
                Change password
              </Link>
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => openDialog("reset")}>
                <KeyIcon />
                Reset password…
              </DropdownMenuItem>
              {active ? (
                <DropdownMenuItem onSelect={() => openDialog("deactivate")}>
                  <UserXIcon />
                  Deactivate…
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => openDialog("activate")}>
                  <UserCheckIcon />
                  Activate…
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => openDialog("delete")}>
                <TrashIcon />
                Delete…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <UserDialog kind={dialog} user={user} open={dialogOpen} onOpenChange={setDialogOpen} returnFocusTo={triggerRef} />
    </>
  );
}
