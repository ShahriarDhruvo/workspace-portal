"use client";

import Link from "next/link";
import { AGENT_NAMES, WORKSPACE_KIND_NAMES, type WorkspaceInfo } from "@portal/core/wire";
import { formatBytes, formatDuration, formatVersion } from "@/lib/format";
import { formatElapsed } from "@/lib/live-format";
import { DataTable, DataTableEmpty, DataTableHead, DataTablePagination, usePagination } from "@/components/common/data-table";
import { StatusDot, type DotTone } from "@/components/common/status-dot";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { KindBadge } from "@/components/workspace/kind-badge";
import { OpenWorkspaceForm } from "./open-workspace-form";

const BUSY: Record<NonNullable<WorkspaceInfo["busyReason"]>, string> = {
  task: "running a task",
  llm: "waiting on the model",
  cpu: "using the CPU",
};

/** The Status cell: a dot and a word, the reason in a tooltip where there is one (an error, a stop that waits). */
function status(workspace: WorkspaceInfo): { tone: DotTone; label: string; pulse: boolean; title: string | null } {
  switch (workspace.status) {
    case "starting":
      return { tone: "warning", label: "Starting", pulse: true, title: null };
    case "stopping":
      return { tone: "warning", label: "Stopping", pulse: true, title: null };
    case "error":
      return { tone: "danger", label: "Error", pulse: false, title: workspace.lastError };
    case "stopped":
      return { tone: "idle", label: "Stopped", pulse: false, title: null };
    case "running": {
      if (!workspace.ready) return { tone: "warning", label: "Starting", pulse: true, title: null };
      if (workspace.busyReason) {
        return {
          tone: "success",
          label: `Working, ${BUSY[workspace.busyReason]}`,
          pulse: true,
          title: workspace.stopPending ? "Everyone signed out while the agent was working; it stops once the work is done." : null,
        };
      }
      const idle = workspace.idleSeconds;
      return { tone: "info", label: idle !== null && idle >= 60 ? `Idle ${formatDuration(idle)}` : "Idle", pulse: false, title: null };
    }
  }
}

const number = "text-right tabular-nums";

interface WorkspacesCardProps {
  /** Every user's workspace (GET /control/workspaces); the stopped ones are left out. */
  workspaces: readonly WorkspaceInfo[];
  /** Display names by user id. */
  names: ReadonlyMap<number, string>;
  /** MAX_RUNNING_WORKSPACES. */
  maxRunning: number | null;
  /** When `workspaces` was read (epoch ms), for "Up for". */
  now: number;
}

/** Admin > Users' workspaces that aren't stopped. */
export function WorkspacesCard({ workspaces, names, maxRunning, now }: WorkspacesCardProps) {
  const list = workspaces.filter((workspace) => workspace.status !== "stopped");
  const running = list.filter((w) => w.status === "running" || w.status === "starting").length;
  const { rows, pagination } = usePagination(list);
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="flex items-baseline gap-2">
          <h2 className="text-16">Workspaces</h2>
          <span className="text-13 font-normal text-muted-foreground tabular-nums">
            {maxRunning === null ? `${running} running` : `${running} of ${maxRunning} running`}
          </span>
        </CardTitle>
        {/* A narrow screen has no AI requests heading to carry the tooltip, and a phone opens none: it is written out. */}
        {list.length > 0 ? (
          <p className="text-13 text-muted-foreground md:hidden">
            AI requests are a user&apos;s requests running on the AI server now: text, images and media.
          </p>
        ) : null}
      </CardHeader>
      <DataTable
        variant="flush"
        footer={<DataTablePagination {...pagination} label="Workspaces pages" />}
        tableProps={{
          // Below a wide screen the type and the harness are under the name; on a narrow one the status and the numbers are too.
          className:
            "max-xl:[&_:is(th,td):is(:nth-child(2),:nth-child(3))]:hidden max-md:[&_:is(th,td):not(:first-child,:last-child)]:hidden",
        }}
      >
        <TableHeader>
          <TableRow>
            <DataTableHead>User</DataTableHead>
            <DataTableHead>Type</DataTableHead>
            <DataTableHead>Harness</DataTableHead>
            <DataTableHead>Status</DataTableHead>
            <DataTableHead align="right">Memory</DataTableHead>
            <DataTableHead align="right" title="The user's requests running on the AI server now: text, images and media">
              AI requests
            </DataTableHead>
            <DataTableHead align="right">Viewers</DataTableHead>
            <DataTableHead align="right">Up for</DataTableHead>
            <DataTableHead>
              <span className="sr-only">Actions</span>
            </DataTableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <DataTableEmpty colSpan={9}>No workspace is running.</DataTableEmpty>
          ) : (
            rows.map((workspace) => {
              const state = status(workspace);
              const name = names.get(workspace.userId) ?? `User #${workspace.userId}`;
              const harness = (
                <span className="flex items-baseline gap-1.5">
                  {workspace.agent ? AGENT_NAMES[workspace.agent] : "—"}
                  {workspace.agentVersion ? (
                    <span className="font-mono text-12 text-muted-foreground">{formatVersion(workspace.agentVersion)}</span>
                  ) : null}
                </span>
              );
              // Where the columns are folded the reason is written out: a touch screen opens no tooltip.
              const statusText = (
                <>
                  <span className="flex items-center gap-1.5">
                    <StatusDot tone={state.tone} pulse={state.pulse} />
                    {state.label}
                  </span>
                  {state.title ? <span className="block text-12 wrap-anywhere text-muted-foreground xl:hidden">{state.title}</span> : null}
                </>
              );
              const memory = workspace.memoryBytes === null ? "—" : formatBytes(workspace.memoryBytes);
              const viewers = workspace.connections.owner + workspace.connections.admin;
              const upFor = workspace.startedAt === null ? "—" : formatElapsed(now - workspace.startedAt);
              return (
                <TableRow key={workspace.userId}>
                  <TableCell className="max-md:whitespace-normal">
                    <Link
                      href={`/admin/users/${workspace.userId}`}
                      className="block font-medium max-md:wrap-anywhere md:max-w-48 md:truncate"
                      title={name}
                    >
                      {name}
                    </Link>
                    <div className="flex items-baseline gap-1 text-12 text-muted-foreground xl:hidden">
                      {WORKSPACE_KIND_NAMES[workspace.kind]} · {harness}
                    </div>
                    <div className="mt-1 md:hidden">{statusText}</div>
                    <dl className="mt-1 flex flex-wrap gap-x-3 text-12 tabular-nums md:hidden">
                      {[
                        ["Memory", memory],
                        ["AI requests", workspace.llmInFlight],
                        ["Viewers", viewers],
                        ["Up for", upFor],
                      ].map(([label, value]) => (
                        <div key={label} className="flex gap-1 whitespace-nowrap">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </TableCell>
                  <TableCell>
                    <KindBadge kind={workspace.kind} />
                  </TableCell>
                  <TableCell>{harness}</TableCell>
                  <TableCell title={state.title ?? undefined} className="max-xl:whitespace-normal">
                    {statusText}
                  </TableCell>
                  <TableCell className={number}>{memory}</TableCell>
                  <TableCell className={number}>{workspace.llmInFlight}</TableCell>
                  <TableCell className={number}>{viewers}</TableCell>
                  <TableCell className={`${number} text-muted-foreground`}>{upFor}</TableCell>
                  <TableCell className="w-0 max-md:align-top">
                    <OpenWorkspaceForm userId={workspace.userId} compact />
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </DataTable>
    </Card>
  );
}
