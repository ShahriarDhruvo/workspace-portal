import type { ApiError } from "./gateway-types";

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

/** Signed out, or a temporary password must be changed first: re-rendering the page redirects. */
export function needsReauth(result: { status: number; error: ApiError }): boolean {
  return result.status === 401 || result.error.error === "password_change_required";
}
