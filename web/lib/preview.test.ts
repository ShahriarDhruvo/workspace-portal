import { test } from "node:test";
import assert from "node:assert/strict";
import { PREVIEW_PORT_PATH, type WorkspaceServer } from "@portal/core/wire";
import { byPort, onlyServer, previewUrl } from "./preview.ts";

const server = (port: number, reachable = true): WorkspaceServer => ({ port, reachable });

test("previewUrl keeps the typed host and scheme, on the preview port, at the path that chooses the workspace's port", () => {
  assert.equal(previewUrl({ protocol: "https:", hostname: "portal.example.lan" }, 22_140, 3000), "https://portal.example.lan:22140/__portal/port/3000/");
  assert.equal(previewUrl({ protocol: "http:", hostname: "[::1]" }, 22_145, 5173), `http://[::1]:22145${PREVIEW_PORT_PATH}5173/`);
});

test("the list is by port, and leaves the gateway's answer as it came", () => {
  const servers = [server(8080), server(3000, false), server(5173)];
  assert.deepEqual(byPort(servers).map(({ port }) => port), [3000, 5173, 8080]);
  assert.deepEqual(servers.map(({ port }) => port), [8080, 3000, 5173]);
  assert.deepEqual(byPort([]), []);
});

test("the button opens a server by itself only when it is the only one and the gateway reaches it", () => {
  assert.deepEqual(onlyServer([server(3000)]), server(3000));
  assert.equal(onlyServer([server(3000, false)]), null, "localhost only: the list says how to open it");
  assert.equal(onlyServer([server(3000), server(5173)]), null);
  assert.equal(onlyServer([server(3000), server(5173, false)]), null, "one reachable among several is still a choice to show");
  assert.equal(onlyServer([]), null);
});
