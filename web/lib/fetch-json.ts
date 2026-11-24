import type { ApiError, WorkspaceKind } from "@portal/core/wire";
import type { WorkspaceStatusResponse } from "./api";
import { runningWorkspace, startErrorText } from "./workspace-kind";

// Browser-side fetch for the portal's JSON routes, normalizing failures to ApiError.

export type FetchResult<T> = { ok: true; data: T } | { ok: false; status: number; error: ApiError };

function isApiError(value: unknown): value is ApiError {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as ApiError).error === "string" &&
    typeof (value as ApiError).message === "string"
  );
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<FetchResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", ...init });
  } catch {
    return { ok: false, status: 0, error: { error: "network", message: "The portal can't be reached right now." } };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return { ok: true, data: body as T };
  return {
    ok: false,
    status: response.status,
    error: isApiError(body) ? body : { error: `http_${response.status}`, message: `The portal answered with HTTP ${response.status}.` },
  };
}

/** Starts the session's workspace of `kind`: the one of its owner's harness. */
export function startWorkspace(kind: WorkspaceKind): Promise<FetchResult<WorkspaceStatusResponse>> {
  return fetchJson("/api/workspace/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) });
}

/**
 * What a refused start says (startErrorText), with the status read after it (null when it can't be read): the refusal
 * may come from a change elsewhere (another workspace started in another tab), and the words name what runs now.
 */
export async function startRefusal(error: ApiError, whose: string): Promise<{ message: string; info: WorkspaceStatusResponse | null }> {
  const fresh = await fetchJson<WorkspaceStatusResponse>("/api/workspace/status");
  const info = fresh.ok ? fresh.data : null;
  return { message: startErrorText(error, whose, info ? runningWorkspace(info) : null), info };
}

export function stopWorkspace(): Promise<FetchResult<WorkspaceStatusResponse>> {
  return fetchJson("/api/workspace/stop", { method: "POST" });
}

/** Signed out, or a temporary password must be changed first: re-rendering the page redirects. */
export function needsReauth(result: { status: number; error: ApiError }): boolean {
  return result.status === 401 || result.error.error === "password_change_required";
}
