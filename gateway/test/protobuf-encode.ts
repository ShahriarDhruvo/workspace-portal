// Test-only protobuf encoding of BuildKit StatusResponse messages (the gateway only ever decodes
// them), for synthetic progress streams.

export function varint(value: number | bigint): number[] {
  let rest = BigInt.asUintN(64, BigInt(value));
  const out: number[] = [];
  do {
    const byte = Number(rest & 0x7fn);
    rest >>= 7n;
    out.push(rest === 0n ? byte : byte | 0x80);
  } while (rest !== 0n);
  return out;
}

function key(field: number, wireType: 0 | 2): number[] {
  return varint((field << 3) | wireType);
}

export function varintField(field: number, value: number | bigint | boolean): number[] {
  return [...key(field, 0), ...varint(typeof value === "boolean" ? (value ? 1 : 0) : value)];
}

export function bytesField(field: number, value: string | Uint8Array | number[]): number[] {
  const data = typeof value === "string" ? [...Buffer.from(value, "utf8")] : [...value];
  return [...key(field, 2), ...varint(data.length), ...data];
}

export function timestamp(ms: number): number[] {
  return [...varintField(1, Math.floor(ms / 1000)), ...varintField(2, (ms % 1000) * 1e6)];
}

export interface VertexFields {
  digest: string;
  name?: string;
  cached?: boolean;
  started?: number;
  completed?: number;
  error?: string;
}

export function vertex(fields: VertexFields): number[] {
  return [
    ...bytesField(1, fields.digest),
    ...bytesField(2, "sha256:input"),
    ...(fields.name === undefined ? [] : bytesField(3, fields.name)),
    ...(fields.cached ? varintField(4, true) : []),
    ...(fields.started === undefined ? [] : bytesField(5, timestamp(fields.started))),
    ...(fields.completed === undefined ? [] : bytesField(6, timestamp(fields.completed))),
    ...(fields.error === undefined ? [] : bytesField(7, fields.error)),
  ];
}

export function statusResponse(parts: { vertexes?: VertexFields[]; logs?: Array<{ vertex: string; msg: string; stream?: number }>; warnings?: Array<{ vertex: string; short: string }> }): Uint8Array {
  return Uint8Array.from([
    ...(parts.vertexes ?? []).flatMap((v) => bytesField(1, vertex(v))),
    // A VertexStatus (layer progress), which the decoder skips.
    ...bytesField(2, [...bytesField(1, "layer"), ...varintField(4, 1024), ...varintField(5, 4096)]),
    ...(parts.logs ?? []).flatMap((log) => bytesField(3, [...bytesField(1, log.vertex), ...bytesField(2, timestamp(0)), ...varintField(3, log.stream ?? 1), ...bytesField(4, log.msg)])),
    ...(parts.warnings ?? []).flatMap((w) => bytesField(4, [...bytesField(1, w.vertex), ...varintField(2, 1), ...bytesField(3, w.short)])),
  ]);
}

/** The engine's JSON message carrying a StatusResponse. */
export function traceMessage(parts: Parameters<typeof statusResponse>[0]): { id: string; aux: string } {
  return { id: "moby.buildkit.trace", aux: Buffer.from(statusResponse(parts)).toString("base64") };
}
