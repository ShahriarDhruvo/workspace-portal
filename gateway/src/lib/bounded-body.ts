// Requests to the services the gateway asks (npm, GitHub, the engine's image registry, the energy price sources),
// with a deadline and a size limit: a document larger than the gateway expects is refused while it streams in, not
// buffered whole first. Responses arrive decompressed (fetch asks for gzip and undoes it), so the limit is on the text.

export const FETCH_TIMEOUT_MS = 10_000;

/** The body as text; null when it is longer than `maxBytes` (the rest is not downloaded). */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One request, with one deadline for the answer and its body: a server that sends headers and then stalls has not
 * answered. `text` is an OK answer's body, null when it is longer than `maxBytes`; with no `maxBytes`, and for any
 * other answer, the body is not read. Rejects as fetch does (a TimeoutError past the deadline).
 */
export async function fetchBounded(
  fetchImpl: typeof fetch,
  url: string | URL,
  { timeoutMs = FETCH_TIMEOUT_MS, maxBytes, ...init }: RequestInit & { timeoutMs?: number; maxBytes?: number },
): Promise<{ ok: boolean; status: number; headers: Headers; text: string | null }> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const { ok, status, headers } = response;
  if (ok && maxBytes !== undefined) return { ok, status, headers, text: await readBoundedText(response, maxBytes) };
  await response.body?.cancel().catch(() => undefined);
  return { ok, status, headers, text: null };
}

/** Why a request failed, for a message: the deadline in words, else the error's own message. */
export function failureReason(error: unknown, timeoutMs = FETCH_TIMEOUT_MS): string {
  return (error as Error).name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : (error as Error).message;
}
