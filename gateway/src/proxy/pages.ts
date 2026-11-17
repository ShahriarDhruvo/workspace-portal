// The gateway's own pages, shown inside the portal's iframe instead of the agent's UI
// while a workspace is starting, stopped or failing, or while the user's other kind runs. Same dark look as the
// Web Shell and the portal. Nothing here starts a workspace by being loaded: a stopped one is started from the
// portal, where the kind is chosen; only "Try again" after a failure (a POST) starts that port's kind again.
import { WORKSPACE_KIND_NAMES, type WorkspaceKind } from "@portal/core";

/** Agent-port paths under this prefix belong to the gateway and are never proxied to the workspace. */
export const PORTAL_PATH_PREFIX = "/__portal/";
/** POST target of the "Try again" buttons: starts that port's kind of the workspace, then redirects to /. */
export const START_PATH = `${PORTAL_PATH_PREFIX}start`;
/**
 * A preview port's entry: `/__portal/port/<n>/<path>` serves the workspace's port n from now on, starting at
 * /<path> (preview-proxy.ts). The Web Shell's Web preview opens `http://localhost:<n>/<path>` this way.
 */
export const PORT_PATH = `${PORTAL_PATH_PREFIX}port/`;

const MAX_DETAIL_CHARS = 4_000;

const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;padding:24px;background:#0a0a0a;color:#fafafa;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
main{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:440px;text-align:center}
.mark{display:flex;align-items:center;justify-content:center;width:28px;height:28px;margin-bottom:6px;border-radius:6px;background:#e5e5e5;color:#171717;font-weight:700;font-size:15px}
.spinner{width:16px;height:16px;border:2px solid #ffffff1a;border-top-color:#a1a1a1;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spinner{animation-duration:2.4s}}
h1{margin:0;font-size:16px;font-weight:600}
p{margin:0;color:#a1a1a1}
pre{width:100%;max-height:220px;margin:4px 0 0;padding:10px 12px;overflow:auto;border:1px solid #ffffff1a;border-radius:6px;background:#171717;color:#a1a1a1;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;text-align:left;white-space:pre-wrap;word-break:break-word}
form{margin:4px 0 0}
.button{display:inline-flex;align-items:center;justify-content:center;height:32px;margin-top:4px;padding:0 14px;border:0;border-radius:6px;background:#e5e5e5;color:#171717;font:inherit;font-weight:500;text-decoration:none;cursor:pointer}
.button:hover{background:#d4d4d4}
.button:focus-visible{outline:none;box-shadow:0 0 0 3px #73737380}
`;

interface PageOptions {
  title: string;
  text: string;
  spinner?: boolean;
  /** Reload the page every this many seconds. */
  refreshSeconds?: number;
  detail?: string | null;
  /** Trusted HTML for the action area. */
  action?: string;
}

function render(options: PageOptions): string {
  const detail = options.detail ? `<pre>${escapeHtml(options.detail.slice(-MAX_DETAIL_CHARS))}</pre>` : "";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark">',
    options.refreshSeconds ? `<meta http-equiv="refresh" content="${options.refreshSeconds}">` : "",
    `<title>${escapeHtml(options.title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    '<div class="mark" aria-hidden="true">W</div>',
    options.spinner ? '<span class="spinner" aria-hidden="true"></span>' : "",
    `<h1>${escapeHtml(options.title)}</h1>`,
    `<p>${escapeHtml(options.text)}</p>`,
    detail,
    options.action ?? "",
    "</main>",
    "</body>",
    "</html>",
  ]
    .filter(Boolean)
    .join("\n")
    .concat("\n");
}

const RETRY_FORM = `<form method="post" action="${START_PATH}"><button class="button" type="submit">Try again</button></form>`;

export function startingPage(kind: WorkspaceKind): string {
  return render({
    title: `Starting your ${WORKSPACE_KIND_NAMES[kind]} workspace…`,
    text: "This usually takes a few seconds. The page reloads by itself.",
    spinner: true,
    refreshSeconds: 2,
  });
}

/** `loginUrl` is protocol-relative (`//host:port/login`) so it keeps the scheme the browser uses. */
export function signedOutPage(loginUrl: string): string {
  return render({
    title: "You're signed out",
    text: "Sign in to the portal to open your workspace.",
    action: `<a class="button" href="${escapeHtml(loginUrl)}" target="_top">Sign in</a>`,
  });
}

export function capacityPage(maxRunning: number): string {
  const slots = maxRunning === 1 ? "The only workspace slot is" : `All ${maxRunning} workspace slots are`;
  return render({
    title: "All workspaces are busy",
    text: `${slots} in use right now. Try again in a few minutes.`,
    action: RETRY_FORM,
  });
}

/** `portalUrl` is protocol-relative (`//host:port/`): the portal's Home, where a workspace is started. */
const portalLink = (portalUrl: string): string => `<a class="button" href="${escapeHtml(portalUrl)}" target="_top">Go to the portal</a>`;

/** A stopped workspace's port: it is started from the portal, where its kind is chosen and confirmed. */
export function stoppedPage(kind: WorkspaceKind, portalUrl: string): string {
  return render({
    title: `Your ${WORKSPACE_KIND_NAMES[kind]} workspace is stopped`,
    text: "Start it from the portal to continue where you left off.",
    action: portalLink(portalUrl),
  });
}

/** One kind's port while the user's other kind runs: only one runs at a time, and this port never reaches it. */
export function otherKindPage(running: WorkspaceKind, kind: WorkspaceKind, portalUrl: string): string {
  return render({
    title: `Your ${WORKSPACE_KIND_NAMES[running]} workspace is running, not this one`,
    text: `Only one of your workspaces runs at a time. Stop the ${WORKSPACE_KIND_NAMES[running]} one in the portal to start the ${WORKSPACE_KIND_NAMES[kind]} one.`,
    action: portalLink(portalUrl),
  });
}

/** A start the gateway refused for good (Online turned off, or not allowed): trying again won't help. */
export function refusedPage(text: string, portalUrl: string): string {
  return render({ title: "Your workspace can't start", text, action: portalLink(portalUrl) });
}

export function errorPage(text: string, detail: string | null): string {
  return render({ title: "Your workspace couldn't start", text, detail, action: RETRY_FORM });
}

export function unreachablePage(): string {
  return render({
    title: "Your workspace isn't answering",
    text: "It may have stopped a moment ago. Reload the page.",
  });
}

/** A preview port opened without a port chosen (`PORT_PATH`): its address alone doesn't say which app. */
export function previewUnchosenPage(): string {
  return render({
    title: "No app chosen",
    text: "Open your app from the Web preview in your workspace: http://localhost followed by the port its server listens on, such as http://localhost:3000.",
  });
}

/** A port a preview can't show: below 1024 (nothing in a workspace may listen there) or the agent's own. */
export function previewBadPortPage(port: string): string {
  return render({
    title: `Port ${port} can't be shown here`,
    text: "Use the port your app's server listens on, from 1024 to 65535.",
  });
}

/** Nothing in the workspace answers on the chosen port. */
export function previewUnreachablePage(port: number): string {
  return render({
    title: `Nothing answers on port ${port}`,
    text: `Start your app's server in the workspace on port ${port}, listening on all addresses (0.0.0.0), not only on localhost: for Vite add --host. Then refresh.`,
  });
}

/** The session is signed in, but this workspace is not the one it has open (another user's, or an admin who moved on). */
export function otherWorkspacePage(portalUrl: string): string {
  return render({
    title: "This workspace isn't open here",
    text: "Your session is using a different workspace. Open it again from the portal.",
    action: portalLink(portalUrl),
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
