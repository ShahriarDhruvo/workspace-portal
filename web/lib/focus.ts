// Focus for dialogs opened by a control that isn't their Radix Trigger (a menu item, one of several buttons that
// share a dialog, a button rendered apart from it): on close, Radix returns the focus to the Trigger, and without
// one it falls to <body>, so keyboard and screen reader users lose their place.
import type { RefObject } from "react";

/**
 * A dialog's onCloseAutoFocus that hands the focus to `target`: the control that opened the dialog, or whatever
 * stands in for it once that control is gone. With no target on the page, Radix's default applies.
 */
export function returnFocus(target: RefObject<HTMLElement | null> | undefined): (event: Event) => void {
  return (event) => {
    const element = target?.current;
    if (!element?.isConnected) return;
    event.preventDefault();
    element.focus();
  };
}
