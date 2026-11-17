// BuildKit's build progress, as the Docker Engine streams it for `version: "2"` builds: each
// `{"id":"moby.buildkit.trace","aux":"<base64>"}` message carries one protobuf
// moby.buildkit.v1.StatusResponse (github.com/moby/buildkit api/services/control/control.proto):
//
//   StatusResponse { repeated Vertex vertexes = 1; repeated VertexStatus statuses = 2;
//                    repeated VertexLog logs = 3; repeated VertexWarning warnings = 4; }
//   Vertex         { string digest = 1; repeated string inputs = 2; string name = 3; bool cached = 4;
//                    Timestamp started = 5; Timestamp completed = 6; string error = 7; ... }
//   VertexLog      { string vertex = 1; Timestamp timestamp = 2; int64 stream = 3; bytes msg = 4; }
//   VertexWarning  { string vertex = 1; int64 level = 2; bytes short = 3; ... }
//   Timestamp      { int64 seconds = 1; int32 nanos = 2; }
//
// Only what the update job shows is decoded: step names, their state, errors, log output and warning
// messages. VertexStatus (layer download progress), a log's stream and a warning's step are skipped.
import { decodeString, readFields } from "./protobuf.ts";

export interface VertexUpdate {
  digest: string;
  /** The step as BuildKit names it, e.g. `[qwen 1/3] RUN npm install -g …`. */
  name: string;
  cached: boolean;
  /** Epoch ms; null while it has not started (or finished). */
  startedAt: number | null;
  completedAt: number | null;
  /** Set when the step failed. */
  error: string;
}

/** Output of a step (stdout and stderr alike: the job log shows both). */
export interface VertexLog {
  vertex: string;
  data: Uint8Array;
}

export interface StatusUpdate {
  vertexes: VertexUpdate[];
  logs: VertexLog[];
  /** Each warning's short message. */
  warnings: string[];
}

export function decodeStatusResponse(bytes: Uint8Array): StatusUpdate {
  const update: StatusUpdate = { vertexes: [], logs: [], warnings: [] };
  for (const field of readFields(bytes)) {
    if (field.wireType !== 2) continue;
    if (field.field === 1) update.vertexes.push(decodeVertex(field.value));
    else if (field.field === 3) update.logs.push(decodeLog(field.value));
    else if (field.field === 4) update.warnings.push(decodeWarning(field.value));
  }
  return update;
}

function decodeVertex(bytes: Uint8Array): VertexUpdate {
  const vertex: VertexUpdate = { digest: "", name: "", cached: false, startedAt: null, completedAt: null, error: "" };
  for (const field of readFields(bytes)) {
    if (field.wireType === 0) {
      if (field.field === 4) vertex.cached = field.value !== 0n;
      continue;
    }
    if (field.field === 1) vertex.digest = decodeString(field.value);
    else if (field.field === 3) vertex.name = decodeString(field.value);
    else if (field.field === 5) vertex.startedAt = decodeTimestamp(field.value);
    else if (field.field === 6) vertex.completedAt = decodeTimestamp(field.value);
    else if (field.field === 7) vertex.error = decodeString(field.value);
  }
  return vertex;
}

function decodeLog(bytes: Uint8Array): VertexLog {
  const log: VertexLog = { vertex: "", data: new Uint8Array() };
  for (const field of readFields(bytes)) {
    if (field.wireType !== 2) continue;
    if (field.field === 1) log.vertex = decodeString(field.value);
    else if (field.field === 4) log.data = field.value;
  }
  return log;
}

function decodeWarning(bytes: Uint8Array): string {
  let message = "";
  for (const field of readFields(bytes)) {
    if (field.field === 3 && field.wireType === 2) message = decodeString(field.value);
  }
  return message;
}

/** google.protobuf.Timestamp as epoch ms (an empty message is the epoch: still "set"). */
function decodeTimestamp(bytes: Uint8Array): number {
  let seconds = 0n;
  let nanos = 0n;
  for (const field of readFields(bytes)) {
    if (field.wireType !== 0) continue;
    if (field.field === 1) seconds = BigInt.asIntN(64, field.value);
    else if (field.field === 2) nanos = BigInt.asIntN(32, field.value);
  }
  return Number(seconds) * 1000 + Math.floor(Number(nanos) / 1e6);
}
