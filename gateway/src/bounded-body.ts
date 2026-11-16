// Bodies of the registries the gateway asks (npm, GitHub), read up to a size limit: a document larger than the
// gateway expects is refused while it streams in, not buffered whole first. Responses arrive decompressed (fetch asks
// for gzip and undoes it), so the limit is on the JSON text.

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
