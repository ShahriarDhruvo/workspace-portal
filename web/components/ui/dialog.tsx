"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { CloseIcon } from "./icons";
import { ICON_BUTTON_CLASS } from "./button";

// Web Shell app dialog: 420px (wide = 560px), 10px radius, #171717 panel with a 1px border and no shadow,
// the whole panel in the mono font, a ruled header (16px/500 title, 28px close button), 16px body.
// The primary button is a shade lighter inside dialogs, as in the Web Shell. Native <dialog>: focus trap,
// Escape and the (very light) backdrop come for free.

interface DialogProps {
  title: string;
  /** Called when the dialog closes (Escape, the close button, or a footer button calling it). */
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}

/** Mount it to open it; unmount it (from onClose) to close it. */
export function Dialog({ title, onClose, children, wide = false }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className={`m-auto max-h-[calc(100dvh-48px)] rounded-xl border border-line bg-surface p-0 font-mono text-14 text-fg transition-[opacity,scale] duration-100 [--shell-primary:var(--shell-primary-dialog)] starting:open:scale-95 starting:open:opacity-0 ${
        wide ? "w-[min(560px,calc(100vw-48px))]" : "w-[min(420px,calc(100vw-48px))]"
      }`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-line-solid py-2.5 pr-2.5 pl-4">
        <h2 id={titleId} className="text-16 leading-none font-medium">
          {title}
        </h2>
        <button type="button" className={ICON_BUTTON_CLASS} aria-label="Close" onClick={() => ref.current?.close()}>
          <CloseIcon />
        </button>
      </div>
      <div className="flex flex-col gap-4 p-4">{children}</div>
    </dialog>
  );
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap justify-end gap-2">{children}</div>;
}
