// A minimal protobuf wire-format reader: just enough to read BuildKit's build progress
// (buildkit-status.ts), so the gateway needs no protobuf library. It yields the fields of one message;
// the caller knows the schema and decodes nested messages by reading their bytes again.
//
// Varint (wire type 0) and length-delimited (2) fields are returned. Fixed-width fields (1, 5) are
// skipped, so a newer BuildKit adding one does not break the reader. Groups (3, 4) were never used by
// BuildKit and are refused, as is anything truncated.

type ProtoField = { field: number; wireType: 0; value: bigint } | { field: number; wireType: 2; value: Uint8Array };

export class ProtobufError extends Error {
  constructor(message: string) {
    super(`malformed protobuf: ${message}`);
    this.name = "ProtobufError";
  }
}

/** Reads a base-128 varint at `offset`; returns the value and the offset after it. */
export function readVarint(bytes: Uint8Array, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  for (let i = offset; i < bytes.length && i < offset + 10; i++) {
    const byte = bytes[i]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: BigInt.asUintN(64, value), next: i + 1 };
    shift += 7n;
  }
  throw new ProtobufError(bytes.length <= offset + 10 ? "truncated varint" : "varint longer than 10 bytes");
}

/** The fields of one message, in wire order (a repeated field appears once per element). */
export function* readFields(bytes: Uint8Array): Generator<ProtoField> {
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.next;
    const field = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    if (field === 0) throw new ProtobufError("field number 0");
    switch (wireType) {
      case 0: {
        const { value, next } = readVarint(bytes, offset);
        offset = next;
        yield { field, wireType, value };
        break;
      }
      case 2: {
        const length = readVarint(bytes, offset);
        const end = length.next + Number(length.value);
        if (length.value > BigInt(bytes.length) || end > bytes.length) throw new ProtobufError(`field ${field} runs past the end`);
        yield { field, wireType, value: bytes.subarray(length.next, end) };
        offset = end;
        break;
      }
      case 1:
      case 5: {
        offset += wireType === 1 ? 8 : 4;
        if (offset > bytes.length) throw new ProtobufError(`field ${field} runs past the end`);
        break;
      }
      default:
        throw new ProtobufError(`unsupported wire type ${wireType} (field ${field})`);
    }
  }
}

const utf8 = new TextDecoder("utf-8");

export function decodeString(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}
