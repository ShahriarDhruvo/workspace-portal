"use client";

import Link from "next/link";
import type { AgentKind } from "@portal/db";
import { formatBytes } from "@/lib/format";
import { formatElapsed } from "@/lib/live-format";
import type { LiveFrame, LiveWorkspace } from "@/lib/live-types";
import { StatusDot, type DotTone } from "@/components/common/status-dot";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

const HEADINGS = [
  { label: "User" },
  { label: "Harness" },
  { label: "Status" },
  { label: "Memory", numeric: true },
  { label: "LLM requests", numeric: true },
  { label: "Viewers", numeric: true },
  { label: "Up for", numeric: true },
];

/** The workspaces that aren't stopped, live: who, which harness, what it is doing and what it uses. */
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
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle>
          <h2 className="text-16">Workspaces</h2>
        </CardTitle>
        <CardDescription className="tabular-nums">
          {running} of {workspaces.maxRunning} running · up to {formatBytes(workspaces.memoryLimitBytes)} memory each
        </CardDescription>
      </CardHeader>
      {workspaces.list.length === 0 ? (
        <Empty className="py-10">
          <EmptyHeader>
            <EmptyTitle className="text-14">No workspace is running</EmptyTitle>
            <EmptyDescription>
              Workspaces start when their user presses Start. See everyone on{" "}
              <Link href="/admin/users" className="underline underline-offset-3">
                Users
              </Link>
              .
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table className="[&_tr>*:first-child]:pl-4 [&_tr>*:last-child]:pr-4">
          <TableHeader>
            <TableRow>
              {HEADINGS.map((heading) => (
                <TableHead key={heading.label} scope="col" className={`h-9 text-12 text-muted-foreground ${heading.numeric ? "text-right" : ""}`}>
                  {heading.label}
                </TableHead>
              ))}
              <TableHead scope="col">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workspaces.list.map((workspace) => {
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
                    <span className="flex items-baseline gap-1.5">
                      {workspace.agent ? agentNames[workspace.agent] : "—"}
                      {workspace.agentVersion ? <span className="font-mono text-12 text-muted-foreground">{workspace.agentVersion}</span> : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1.5">
                      <StatusDot tone={state.tone} pulse={state.pulse} />
                      {state.label}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{workspace.memoryBytes === null ? "—" : formatBytes(workspace.memoryBytes)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{workspace.llmInFlight}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{workspace.open}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {workspace.startedAt === null ? "—" : formatElapsed(now - workspace.startedAt)}
                  </TableCell>
                  <TableCell className="w-0">
                    <OpenWorkspaceForm userId={workspace.userId} label="Open" />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
