// The fence probe against real loopback sockets. The "loaded" answer needs the nftables table itself (an
// EHOSTUNREACH from the kernel): deploy/verify-isolation.sh checks it on a live install.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { fenceCheck, probeFence } from "./fence.ts";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("nothing refuses the connection as prohibited: the table is missing (refused, or something listens there)", async () => {
  const port = await freePort();
  assert.equal(await probeFence(port), "missing", "ECONNREFUSED");
  assert.equal(await fenceCheck(port)(), "missing");

  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    assert.equal(await probeFence(port), "missing", "connected: no marker in the way");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
