"use client";

import { useEffect, useState } from "react";
import { buttonClass } from "./button";
import { CheckIcon, CopyIcon } from "./icons";

/** navigator.clipboard needs a secure context; the portal is often served over plain HTTP on a LAN. */
async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path (e.g. permission denied).
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  return copied;
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <button
      type="button"
      className={buttonClass("outline", "sm")}
      onClick={async () => setState((await copyText(value)) ? "copied" : "failed")}
    >
      {state === "copied" ? <CheckIcon /> : <CopyIcon />}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : label}</span>
    </button>
  );
}

/** A one-time secret (temporary password) in a code-block style well, selectable, with a copy button. */
export function SecretValue({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-raised py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-14 select-all">{value}</code>
      <CopyButton value={value} />
    </div>
  );
}
