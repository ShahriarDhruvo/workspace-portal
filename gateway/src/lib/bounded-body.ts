// Reading with a size limit, and fetching with a deadline as well: a body larger than the gateway expects is refused
// while it streams in, not buffered whole first. fetch undoes gzip, so its limit is on the decompressed text.

export const FETCH_TIMEOUT_MS = 10_000;

/** The whole body; null when it is longer than `maxBytes` (leaving the loop cancels the rest). */
export async function readBounded(body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, maxBytes: number): Promise<Buffer | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  return (await readBounded(response.body ?? [], maxBytes))?.toString("utf8") ?? null;
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
