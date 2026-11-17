// Binding servers, with retries for addresses that appear later (the workspace bridge's gateway IP
// exists only once Docker has brought the bridge up).
import type { Server } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const RETRY_INTERVAL_MS = 1_000;

export interface ListenOptions {
  host: string;
  port: number;
  /** Keep retrying EADDRNOTAVAIL for this long. */
  waitForAddressMs?: number;
  onRetry?: (error: Error) => void;
}

export async function listen(server: Server, options: ListenOptions): Promise<void> {
  const deadline = Date.now() + (options.waitForAddressMs ?? 0);
  for (;;) {
    try {
      await listenOnce(server, options.host, options.port);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRNOTAVAIL" || Date.now() >= deadline) throw error;
      options.onRetry?.(error as Error);
      await delay(RETRY_INTERVAL_MS);
    }
  }
}

function listenOnce(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
