// JSON-lines logger. Only the fields a caller passes are written, so never pass request headers,
// cookies, tokens or secrets. Error values are reduced to their message and code.

type Level = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const emit = (level: Level, message: string, fields?: LogFields): void => {
    write(JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...serialize(fields) }));
  };
  return {
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serialize(fields: LogFields | undefined): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    out[key] = value instanceof Error ? describeError(value) : value;
  }
  return out;
}

function describeError(error: Error): LogFields {
  const code = (error as NodeJS.ErrnoException).code;
  return code === undefined ? { message: error.message } : { message: error.message, code };
}
