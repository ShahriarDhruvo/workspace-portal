"use client";

import Link from "next/link";
import type { AgentKind } from "@portal/db";
import { formatBytes, formatVersion } from "@/lib/format";
import { formatElapsed } from "@/lib/live-format";
import type { LiveFrame, LiveWorkspace } from "@/lib/live-types";
import { DataTable, DataTableEmpty, DataTableHead, DataTablePagination, usePagination } from "@/components/common/data-table";
import { StatusDot, type DotTone } from "@/components/common/status-dot";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { KindBadge } from "@/components/workspace/kind-badge";
import { OpenWorkspaceForm } from "../open-workspace-form";

const BUSY: Record<NonNullable<LiveWorkspace["busyReason"]>, string> = {
  task: "running a task",
  llm: "waiting on the model",
  cpu: "using the CPU",
};

function status(workspace: LiveWorkspace): { tone: DotTone; label: string; pulse: boolean } {
  switch (workspace.status) {
    case "starting":
      return { tone: "warning", label: "Starting", pulse: true };
    case "stopping":
      return { tone: "warning", label: "Stopping", pulse: true };
    case "error":
      return { tone: "danger", label: "Error", pulse: false };
    case "stopped":
      return { tone: "idle", label: "Stopped", pulse: false };
    case "running":
      return workspace.busy
        ? { tone: "success", label: `Working, ${BUSY[workspace.busyReason ?? "task"]}`, pulse: true }
        : { tone: "info", label: "Idle", pulse: false };
  }
}

const number = "text-right tabular-nums";

/** The workspaces that aren't stopped, live: who, which kind and harness, what it is doing and what it uses. */
export function WorkspacesCard({
  workspaces,
  now,
  agentNames,
}: {
  workspaces: LiveFrame["workspaces"];
  now: number;
  agentNames: Readonly<Record<AgentKind, string>>;
}) {
  const running = workspaces.list.filter((w) => w.status === "running" || w.status === "starting").length;
  const { rows, pagination } = usePagination(workspaces.list);
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="flex items-baseline gap-2">
          <h2 className="text-16">Workspaces</h2>
          <span className="text-13 font-normal text-muted-foreground tabular-nums">
            {running} of {workspaces.maxRunning} running
          </span>
        </CardTitle>
      </CardHeader>
      <DataTable variant="flush" footer={<DataTablePagination {...pagination} label="Workspaces pages" />}>
        <TableHeader>
          <TableRow>
            <DataTableHead>User</DataTableHead>
            <DataTableHead>Type</DataTableHead>
            <DataTableHead>Harness</DataTableHead>
            <DataTableHead>Status</DataTableHead>
            <DataTableHead align="right">Memory</DataTableHead>
            <DataTableHead align="right">LLM requests</DataTableHead>
            <DataTableHead align="right">Viewers</DataTableHead>
            <DataTableHead align="right">Up for</DataTableHead>
            <DataTableHead>
              <span className="sr-only">Actions</span>
            </DataTableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <DataTableEmpty colSpan={9}>
              No workspace is running. See everyone on{" "}
              <Link href="/admin/users" className="underline underline-offset-3 hover:text-foreground">
                Users
              </Link>
              .
            </DataTableEmpty>
          ) : (
            rows.map((workspace) => {
              const state = status(workspace);
              const name = workspace.userName ?? `User #${workspace.userId}`;
              return (
                <TableRow key={workspace.userId}>
                  <TableCell>
                    <Link href={`/admin/users/${workspace.userId}`} className="block max-w-48 truncate font-medium" title={name}>
                      {name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <KindBadge kind={workspace.kind} />
                  </TableCell>
                  <TableCell>
                    <span className="flex items-baseline gap-1.5">
                      {workspace.agent ? agentNames[workspace.agent] : "—"}
                      {workspace.agentVersion ? (
                        <span className="font-mono text-12 text-muted-foreground">{formatVersion(workspace.agentVersion)}</span>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <StatusDot tone={state.tone} pulse={state.pulse} />
                      {state.label}
                    </span>
                  </TableCell>
                  <TableCell className={number}>{workspace.memoryBytes === null ? "—" : formatBytes(workspace.memoryBytes)}</TableCell>
                  <TableCell className={number}>{workspace.llmInFlight}</TableCell>
                  <TableCell className={number}>{workspace.open}</TableCell>
                  <TableCell className={`${number} text-muted-foreground`}>
                    {workspace.startedAt === null ? "—" : formatElapsed(now - workspace.startedAt)}
                  </TableCell>
                  <TableCell className="w-0">
                    <OpenWorkspaceForm userId={workspace.userId} />
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
