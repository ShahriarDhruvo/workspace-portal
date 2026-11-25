// For tests that stand in for a harness's web server (the drivers' here, the gateway's own).
import type http from "node:http";
import type { AddressInfo } from "node:net";

export async function listenLocal(server: http.Server, port = 0, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

export async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
