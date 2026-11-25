import { test } from "node:test";
import assert from "node:assert/strict";
import { listeningServers, MAX_SERVERS } from "./servers.ts";

const HEAD4 = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const HEAD6 = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const TAIL = "00000000:00000000 00:00000000 00000000 200000        0 71234 1 0000000000000000 100 0 0 10 0";
const hex = (port: number): string => port.toString(16).toUpperCase().padStart(4, "0");
const v4 = (address: string, port: number, state = "0A"): string => `   0: ${address}:${hex(port)} 00000000:0000 ${state} ${TAIL}`;
const v6 = (address: string, port: number, state = "0A"): string => `   0: ${address}:${hex(port)} ${"0".repeat(32)}:0000 ${state} ${TAIL}`;

const ANY4 = "00000000";
const LOCAL4 = "0100007F"; // 127.0.0.1
const OWN4 = "0300640A"; // 10.100.0.3
const ANY6 = "0".repeat(32);
const LOCAL6 = `${"0".repeat(24)}01000000`; // ::1
const mapped = (address: string): string => `${"0".repeat(16)}FFFF0000${address}`; // ::ffff:a.b.c.d

/** In a container at 10.100.0.3 whose agent listens on 4096. */
const servers = (lines: string[]) => listeningServers(lines.join("\n"), "10.100.0.3", 4096);

test("a server on every address, or on the container's own, can be reached; one on localhost only is listed as not", () => {
  assert.deepEqual(servers([HEAD4, v4(ANY4, 3000), v4(LOCAL4, 5173), v4(OWN4, 8080), HEAD6, v6(ANY6, 8000), v6(LOCAL6, 4321), v6(mapped(LOCAL4), 9000), v6(mapped(OWN4), 9001)]), [
    { port: 3000, reachable: true },
    { port: 4321, reachable: false },
    { port: 5173, reachable: false },
    { port: 8000, reachable: true },
    { port: 8080, reachable: true },
    { port: 9000, reachable: false },
    { port: 9001, reachable: true },
  ]);
});

test("a port is listed once, reachable if any of its sockets is", () => {
  assert.deepEqual(servers([v4(LOCAL4, 3000), v6(ANY6, 3000), v6(LOCAL6, 3000)]), [{ port: 3000, reachable: true }]);
});

test("the agent's own port, the ports only root binds, and sockets that do not listen are left out", () => {
  assert.deepEqual(servers([v4(OWN4, 4096), v4(ANY4, 80), v4(ANY4, 1023), v4(ANY4, 1024), v4(OWN4, 3000, "01"), v6(ANY6, 3001, "06")]), [{ port: 1024, reachable: true }]);
});

test("a localhost port the kernel picked is a helper's, not a web server", () => {
  assert.deepEqual(servers([v4(LOCAL4, 32767), v4(LOCAL4, 32768), v6(LOCAL6, 45123), v4(ANY4, 45124)]), [
    { port: 32767, reachable: false },
    { port: 45124, reachable: true },
  ]);
});

test("another address of the container's, or another machine's, is no way in", () => {
  assert.deepEqual(servers([v4("0400640A", 3000), v6(`20010DB8${"0".repeat(24)}`, 3001)]), []);
});

test("text of any other form is not read, and a long table is cut", () => {
  assert.deepEqual(servers(["", "garbage", "0: 00000000:0BB8", v4("0000000", 3000), v4(ANY4, 3000).toLowerCase(), `x${v4(ANY4, 3000)}`, v4(ANY4, 3000).replace(" 0A ", " 0A"), "   0: 00000000:0BB8 00000000:0000 0A"]), []);
  const many = servers(Array.from({ length: 100 }, (_, i) => v4(ANY4, 5000 - i)));
  assert.equal(many.length, MAX_SERVERS);
  assert.deepEqual(many[0], { port: 4901, reachable: true }, "lowest ports first");
});
