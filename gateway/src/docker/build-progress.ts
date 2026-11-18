// Turns the Docker Engine's build stream into what an update job shows: the current step and log
// lines in the style of `docker build --progress=plain` (`#5 [qwen 1/3] RUN npm install …`, the
// command's output prefixed with `#5`, then `#5 DONE 21.3s`), plus the error the engine reported when
// the build failed. Pure (no I/O), so it is tested against a recorded trace.
//
// The stream is JSON lines. BuildKit builds (`version: "2"`) send
//   {"id":"moby.buildkit.trace","aux":"<base64 StatusResponse>"}  progress (buildkit-status.ts)
//   {"error":"…","errorDetail":{"message":"…"}}                    a failure
// Anything else adds nothing, the result's image id (`moby.image.id`) included: the builder inspects the image
// it tagged instead.
import { decodeStatusResponse, type StatusUpdate } from "./buildkit-status.ts";
import { ProtobufError } from "./protobuf.ts";

/** Longer lines are cut (npm can print minified code); the job keeps only the last lines anyway. */
const MAX_LINE_LENGTH = 500;
/** Output without a newline for this long is shown as a line of its own. */
const MAX_PARTIAL_LENGTH = 4096;

/** Splits a byte stream into JSON values, one per line; lines that are not JSON are skipped. */
export class JsonLineDecoder {
  readonly #text = new TextDecoder("utf-8");
  #buffer = "";

  push(chunk: Uint8Array | string): unknown[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#text.decode(chunk, { stream: true });
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    return parseLines(lines);
  }

  end(): unknown[] {
    const rest = this.#buffer + this.#text.decode();
    this.#buffer = "";
    return parseLines([rest]);
  }
}

function parseLines(lines: string[]): unknown[] {
  const values: unknown[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      // Not a progress message (the engine sends nothing else, but a proxy might).
    }
  }
  return values;
}

interface VertexState {
  /** The `#N` of plain progress output: numbered in the order steps are first shown; 0 until then. */
  n: number;
  name: string;
  announced: boolean;
  startedAt: number | null;
  done: boolean;
  /** Output since the last newline. */
  partial: string;
}

export class BuildProgress {
  /** The step the build is at: the latest step still running, else the last one that ran. */
  step: string | null = null;
  /** What the engine reported when the build failed. */
  error: string | null = null;
  readonly #vertexes = new Map<string, VertexState>();
  #shown = 0;
  /** A progress message could not be decoded (said once per build). */
  #unreadable = false;

  /** Reads one message of the build stream; returns the log lines it adds. */
  push(message: unknown): string[] {
    if (typeof message !== "object" || message === null) return [];
    const record = message as Record<string, unknown>;
    const lines: string[] = [];
    if (typeof record.error === "string" || (typeof record.errorDetail === "object" && record.errorDetail !== null)) {
      const detail = (record.errorDetail as { message?: unknown } | null | undefined)?.message;
      this.error = (typeof detail === "string" && detail) || (typeof record.error === "string" && record.error) || "the build failed";
      lines.push(...this.#flushAll(), clean(`ERROR: ${this.error}`));
      return lines;
    }
    if (record.id === "moby.buildkit.trace" && typeof record.aux === "string") {
      let update: StatusUpdate;
      try {
        update = decodeStatusResponse(Buffer.from(record.aux, "base64"));
      } catch (error) {
        if (!(error instanceof ProtobufError)) throw error;
        // Progress is only for show: a message this reader can't decode (a newer BuildKit, a damaged
        // stream) must not fail the build, whose outcome comes from the engine. One warning is enough.
        if (this.#unreadable) return [];
        this.#unreadable = true;
        return [clean(`WARNING: unreadable build progress (${error.message})`)];
      }
      return this.#apply(update);
    }
    return [];
  }

  /** Output still waiting for a newline when the stream ends. */
  finish(): string[] {
    return this.#flushAll();
  }

  #apply(update: StatusUpdate): string[] {
    const lines: string[] = [];
    for (const vertex of update.vertexes) {
      const state = this.#vertex(vertex.digest);
      if (vertex.name) state.name = vertex.name;
      if (state.done) continue;
      if (!state.announced && (vertex.startedAt !== null || vertex.cached)) {
        state.announced = true;
        lines.push(clean(`#${this.#number(state)} ${state.name}`));
      }
      if (vertex.startedAt !== null) state.startedAt = vertex.startedAt;
      if (vertex.error) {
        state.done = true;
        lines.push(...this.#flush(state), clean(`#${state.n} ERROR: ${vertex.error}`));
      } else if (vertex.cached && vertex.completedAt !== null) {
        state.done = true;
        lines.push(...this.#flush(state), `#${state.n} CACHED`);
      } else if (vertex.completedAt !== null) {
        state.done = true;
        const seconds = state.startedAt === null ? null : Math.max(0, vertex.completedAt - state.startedAt) / 1000;
        lines.push(...this.#flush(state), seconds === null ? `#${state.n} DONE` : `#${state.n} DONE ${seconds.toFixed(1)}s`);
      }
    }
    for (const log of update.logs) {
      const state = this.#vertex(log.vertex);
      this.#number(state);
      state.partial += Buffer.from(log.data).toString("utf8");
      const parts = state.partial.split("\n");
      state.partial = parts.pop() ?? "";
      if (state.partial.length > MAX_PARTIAL_LENGTH) {
        parts.push(state.partial);
        state.partial = "";
      }
      for (const part of parts) lines.push(...splitOutput(part).map((line) => clean(`#${state.n} ${line}`)));
    }
    for (const warning of update.warnings) lines.push(clean(`WARNING: ${warning}`));
    this.#updateStep();
    return lines;
  }

  #vertex(digest: string): VertexState {
    let state = this.#vertexes.get(digest);
    if (!state) {
      state = { n: 0, name: digest, announced: false, startedAt: null, done: false, partial: "" };
      this.#vertexes.set(digest, state);
    }
    return state;
  }

  #number(state: VertexState): number {
    if (state.n === 0) state.n = ++this.#shown;
    return state.n;
  }

  #updateStep(): void {
    let latest: VertexState | null = null;
    for (const state of this.#vertexes.values()) {
      if (state.announced && !state.done && state.startedAt !== null && (latest === null || state.n > latest.n)) latest = state;
    }
    if (latest) this.step = latest.name;
  }

  #flush(state: VertexState): string[] {
    const rest = state.partial;
    state.partial = "";
    return rest.trim() === "" ? [] : splitOutput(rest).map((line) => clean(`#${state.n} ${line}`));
  }

  #flushAll(): string[] {
    return [...this.#vertexes.values()].flatMap((state) => this.#flush(state));
  }
}

/**
 * Lines of command output, as a terminal would leave them: a carriage return starts the line over
 * (progress bars), blank lines are dropped.
 */
function splitOutput(text: string): string[] {
  return text
    .split("\n")
    .map((line) => {
      const parts = line.replace(/\r+$/, "").split("\r");
      return parts[parts.length - 1] ?? "";
    })
    .filter((line) => line.trim() !== "");
}

/** Without terminal escapes and control characters, and not too long. */
function clean(line: string): string {
  // eslint-disable-next-line no-control-regex
  const text = line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trimEnd();
  return text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH - 1)}…` : text;
}
