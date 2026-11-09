"use client";

import Link from "next/link";
import { useId, useRef, type KeyboardEvent, type ReactNode, type ToggleEvent } from "react";
import { ICON_BUTTON_CLASS } from "./button";
import { EllipsisIcon } from "./icons";

// Web Shell dropdown menu: solid #171717 panel (no blur), 6px radius, 4px padding, 1px border plus shadow-md;
// 28px items with 4px radius and a raised fill on hover/focus; destructive items in red with a red tint.
// Uses the Popover API so it renders in the top layer (never clipped by a scrolling table) and gets
// light dismiss (outside click, Escape) from the browser.

const ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-left text-14 outline-none " +
  "disabled:cursor-not-allowed disabled:bg-transparent disabled:opacity-50 [&_svg]:shrink-0";
const ITEM_TONES = {
  default: "text-fg hover:bg-pressed focus-visible:bg-pressed",
  danger: "text-destructive hover:bg-destructive/20 focus-visible:bg-destructive/20",
} as const;

export function Menu({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function items(): HTMLElement[] {
    return Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
  }

  function onToggle(event: ToggleEvent<HTMLDivElement>) {
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;
    const open = event.newState === "open";
    trigger.setAttribute("aria-expanded", String(open));
    if (!open) return;
    const anchor = trigger.getBoundingClientRect();
    const left = Math.min(Math.max(8, anchor.right - menu.offsetWidth), window.innerWidth - menu.offsetWidth - 8);
    const below = anchor.bottom + 4;
    const top =
      below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, anchor.top - 4 - menu.offsetHeight) : below;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    items()[0]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (move !== undefined) {
      event.preventDefault();
      list[(index + move + list.length) % list.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? list[0] : list[list.length - 1])?.focus();
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-expanded="false"
        aria-label={label}
        className={ICON_BUTTON_CLASS}
      >
        <EllipsisIcon />
      </button>
      <div
        ref={menuRef}
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        onToggle={onToggle}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('[role="menuitem"]')) menuRef.current?.hidePopover();
        }}
        className="fixed inset-auto m-0 min-w-44 max-w-90 rounded-md border border-line bg-surface p-1 text-fg shadow-md"
      >
        <div className="flex flex-col">{children}</div>
      </div>
    </>
  );
}

interface MenuItemProps {
  icon?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  tone?: keyof typeof ITEM_TONES;
  disabled?: boolean;
}

export function MenuItem({ icon, children, onSelect, tone = "default", disabled }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={`${ITEM_CLASS} ${ITEM_TONES[tone]}`}
    >
      {icon}
      {children}
    </button>
  );
}

export function MenuLink({ icon, children, href }: { icon?: ReactNode; children: ReactNode; href: string }) {
  return (
    <Link href={href} role="menuitem" className={`${ITEM_CLASS} ${ITEM_TONES.default}`}>
      {icon}
      {children}
    </Link>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="-mx-1 my-1 h-px bg-line" />;
}
