"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AgentKind } from "@portal/db";
import { fetchJson } from "@/lib/fetch-json";
import { agentLabel, summarizeWorkspace } from "@/lib/format";
import type { AdminOverview, WorkspaceInfo } from "@/lib/gateway-types";
import type { UserSummary } from "@/lib/user-summary";
import { Avatar } from "@/components/brand";
import { StatusDot } from "@/components/common/status-dot";
import { LocalTime } from "@/components/local-time";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HostStats } from "./host-stats";
import { OpenWorkspaceForm } from "./open-workspace-form";
import { ServiceIssue } from "./service-issue";
import { UserDialog, type DialogUser, type UserDialogKind } from "./user-dialogs";

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
      {overview.error ? <ServiceIssue message={overview.error.message}>Workspace status may be out of date.</ServiceIssue> : null}
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
        <Table stacked="xl">
          <TableHeader>
            <TableRow>
              {["Name", "Username", "Role", "Account", "Workspace", "Agent", "Last sign-in"].map((heading) => (
                <TableHead key={heading} scope="col">
                  {heading}
                </TableHead>
              ))}
              <TableHead scope="col">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
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
          </TableBody>
        </Table>
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
  const summary = workspace === undefined ? null : summarizeWorkspace(workspace, idleTimeoutMinutes);
  const running = workspace?.status === "running" || workspace?.status === "starting";
  const agent = workspace ? agentLabel(workspace, agentNames) : null;

  return (
    <TableRow>
      <TableCell>
        {/* A long name wraps: 2px down, its first line is level with the 24px avatar. */}
        <Link
          href={`/admin/users/${user.id}`}
          className="hit-area relative flex min-w-0 items-start gap-2 rounded-sm font-medium text-foreground"
        >
          <Avatar initials={user.initials} />
          <span className="mt-0.5 min-w-24 wrap-anywhere">{user.name}</span>
          {isSelf ? (
            <Badge variant="outline" className="mt-0.5">
              You
            </Badge>
          ) : null}
        </Link>
      </TableCell>
      <TableCell label="Username" className="text-muted-foreground">
        {user.username}
      </TableCell>
      <TableCell label="Role">{user.role === "admin" ? <Badge>Admin</Badge> : <Badge variant="outline">User</Badge>}</TableCell>
      <TableCell label="Account">
        {user.active ? <Badge variant="success">Active</Badge> : <Badge variant="neutral">Deactivated</Badge>}
      </TableCell>
      <TableCell label="Workspace" title={summary?.title ?? undefined}>
        {summary ? (
          <span className="flex flex-wrap items-center gap-x-1">
            <span className="flex items-center gap-1.5 text-foreground">
              <StatusDot tone={summary.tone} pulse={summary.label === "Working"} />
              {summary.label}
              {/* With the label, so that facts that wrap to a line of their own don't start with the dot. */}
              {summary.detail ? <span className="text-muted-foreground">·</span> : null}
            </span>
            {summary.detail ? <span className="text-muted-foreground">{summary.detail}</span> : null}
          </span>
        ) : (
          <span className="text-muted-foreground">Unknown</span>
        )}
      </TableCell>
      <TableCell label="Agent" className={running ? "text-foreground" : "text-muted-foreground"}>
        {/* The version moves under the name before either breaks. */}
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="whitespace-nowrap">{agent ?? "—"}</span>
          {agent && workspace?.agentVersion ? (
            <span className="font-mono text-12 text-muted-foreground">{workspace.agentVersion}</span>
          ) : null}
        </span>
      </TableCell>
      <TableCell label="Last sign-in" className="text-muted-foreground">
        {user.lastLoginAt ? <LocalTime at={user.lastLoginAt} relative /> : "Never"}
      </TableCell>
      <TableCell className="w-0 stacked:w-auto">
        <div className="flex items-center justify-end gap-1 pointer-coarse:gap-2">
          <OpenWorkspaceForm userId={user.id} label="Open" />
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
          <Button ref={triggerRef} type="button" variant="muted" size="icon" aria-label={`Actions for ${user.name}`}>
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
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
              <Link href="/change-password">
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
