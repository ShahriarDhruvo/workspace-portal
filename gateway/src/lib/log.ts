// JSON-lines logger. Only the fields a caller passes are written, so never pass request headers, cookies, tokens or
// secrets. Error values are reduced to their message and code.
export type LogFields = Record<string, unknown>;
type Log = (message: string, fields?: LogFields) => void;

export interface Logger {
  info: Log;
  warn: Log;
  error: Log;
}

export function createLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const emit = (level: string): Log => (message, fields = {}) => {
    const shown = Object.entries(fields).map(([key, value]) => [key, value instanceof Error ? { message: value.message, code: (value as NodeJS.ErrnoException).code } : value]);
    write(JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...Object.fromEntries(shown) }));
  };
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
