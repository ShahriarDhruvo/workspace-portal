// Browser clipboard helper. navigator.clipboard needs a secure context, and the portal is often served over
// plain HTTP on a LAN, so it falls back to a hidden textarea and the legacy copy command.

/**
 * Copies `text`; resolves to false when nothing was copied (the person can still select and copy). `origin` is the
 * control that asked: the fallback's textarea goes beside it, so it is inside any focus trap around it. A modal
 * dialog would otherwise take the focus straight back from a textarea elsewhere on the page, leaving nothing
 * selected, and the copy command would still report success.
 */
export async function copyText(text: string, origin: HTMLElement): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path (e.g. permission denied).
    }
  }
  return legacyCopy(text, origin.parentElement ?? document.body);
}

/** The legacy copy command on a hidden textarea placed in `host`; the focus goes back where it was. */
function legacyCopy(text: string, host: HTMLElement): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.tabIndex = -1;
  area.setAttribute("aria-hidden", "true");
  Object.assign(area.style, { position: "fixed", top: "0", left: "0", opacity: "0", pointerEvents: "none" });
  host.append(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    // The command copies the focused selection, and answers true even when there is none: check it is ours.
    const selected = document.activeElement === area && area.selectionStart === 0 && area.selectionEnd === text.length;
    return selected && document.execCommand("copy");
  } catch {
    return false;
  } finally {
    previous?.focus({ preventScroll: true });
    area.remove();
  }
}
