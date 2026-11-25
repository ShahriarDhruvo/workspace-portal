"use client";

import { useState } from "react";
import type { WorkspaceServersResponse } from "@/lib/api";
import { byPort, onlyServer, previewUrl } from "@/lib/preview";
import { usePoll } from "@/components/common/use-poll";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { PreviewIcon, RightUpIcon } from "@/components/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// The web servers running in the session's workspace (a dev server, a built site), opened from the top bars. The
// gateway shows them on the workspace's preview port, a browser origin apart from the portal's and the agent's, one
// server at a time: the address that opens a server also makes it the one that origin serves.

const POLL_MS = 5_000;

/** Only its icon on phones, as icon-sm's square (the workspace bar's Stop does the same). */
const BUTTON = "animate-in fade-in max-sm:w-7 max-sm:px-0";

/**
 * The bars' Preview button, there only while a web server runs in the workspace. A single server the gateway
 * reaches opens from the button itself; several, or one that listens on localhost only, are listed first.
 */
export function PreviewButton() {
  const [answer, setAnswer] = useState<WorkspaceServersResponse | null>(null);
  // A failed poll says nothing about the servers: the last answer stays.
  usePoll<WorkspaceServersResponse>(
    "/api/workspace/servers",
    POLL_MS,
    (result) => {
      if (result.ok) setAnswer(result.data);
    },
    0,
  );

  if (!answer || answer.previewPort === null || answer.servers.length === 0) return null;
  const { previewPort, servers } = answer;
  // An answer only ever arrives in the browser, so the host the user typed is at hand.
  const href = (port: number) => previewUrl(window.location, previewPort, port);
  const label = <span className="max-sm:sr-only">Preview</span>;

  const only = onlyServer(servers);
  if (only) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild variant="outline" size="sm" className={BUTTON}>
            <a href={href(only.port)} target="_blank" rel="noopener noreferrer">
              <PreviewIcon />
              {label}
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Opens port {only.port} in a new tab</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className={BUTTON}>
          <PreviewIcon />
          {label}
          <Badge variant="secondary" className="max-sm:sr-only">
            {servers.length}
            <span className="sr-only">{servers.length === 1 ? " web server" : " web servers"}</span>
          </Badge>
        </Button>
      </DialogTrigger>
      {/* The list scrolls inside the dialog, which never outgrows the screen; its padding keeps the focus rings whole. */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <DialogHeader className="pr-8">
          <DialogTitle>Web servers in this workspace</DialogTitle>
          <DialogDescription>
            Each opens in a new tab. The preview shows one server at a time: opening another switches every preview tab of this workspace to it.
          </DialogDescription>
        </DialogHeader>
        <ul className="-m-1 flex min-h-0 flex-col gap-2 overflow-y-auto p-1">
          {byPort(servers).map(({ port, reachable }) => (
            <li key={port} className="flex flex-col gap-1">
              {reachable ? (
                <DialogClose asChild>
                  <Button asChild variant="outline" className="w-full justify-between">
                    <a href={href(port)} target="_blank" rel="noopener noreferrer">
                      Port {port}
                      <RightUpIcon data-icon="inline-end" />
                    </a>
                  </Button>
                </DialogClose>
              ) : (
                <>
                  <Button type="button" variant="outline" disabled aria-describedby={`preview-${port}-note`} className="w-full justify-start">
                    Port {port}
                  </Button>
                  <p id={`preview-${port}-note`} className="text-13 text-muted-foreground">
                    Listens on localhost only. Restart it on 0.0.0.0 (for example with --host 0.0.0.0) to open it here.
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
