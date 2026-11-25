"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowRightIcon } from "@/components/ui/icons";
import { PreviewButton, useRunningWorkspace } from "@/components/workspace/preview-button";

/**
 * The bar's buttons of the running workspace: Preview while a web server runs in it, and the way back to it, which
 * is otherwise two steps away (Home, then its button). Nothing while no workspace runs.
 */
export function WorkspaceButtons() {
  const running = useRunningWorkspace();
  if (!running) return null;
  return (
    <>
      <PreviewButton workspace={running} />
      <Button asChild variant="outline" size="sm" className="animate-in fade-in">
        <Link href="/workspace">
          Workspace
          <ArrowRightIcon />
        </Link>
      </Button>
    </>
  );
}
