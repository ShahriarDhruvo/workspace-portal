"use client";

import { useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { CheckIcon, CopyIcon } from "@/components/ui/icons";

/** Copies `value`; says "Copied" (or "Select and copy" if the browser refused) for two seconds. */
function CopyButton({ value }: { value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async (event) => setState((await copyText(value, event.currentTarget)) ? "copied" : "failed")}
    >
      {state === "copied" ? <CheckIcon /> : <CopyIcon />}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : "Copy"}</span>
    </Button>
  );
}

/** A one-time secret (temporary password) in a code-block style well, selectable, with a copy button. */
export function SecretValue({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-14 select-all">{value}</code>
      <CopyButton value={value} />
    </div>
  );
}
