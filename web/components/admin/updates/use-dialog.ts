"use client";

import { useRef, useState } from "react";

/** A card's one dialog: what it shows, whether it is open, and the control that opened it, which gets the focus back. */
export function useDialog<T>(initial: T) {
  const [dialog, setDialog] = useState(initial);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);

  function show(next: T, from: HTMLElement) {
    opener.current = from;
    setDialog(next);
    setOpen(true);
  }
  return { dialog, open, setOpen, opener, show };
}
