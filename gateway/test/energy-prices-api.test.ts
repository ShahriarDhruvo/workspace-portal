// The control API's electricity price routes (Admin > Settings picks a place; the web app asks for a download).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { energyPrices } from "@portal/core";
import { EIA_URL } from "../src/monitor/energy-prices.ts";
import { startGateway } from "./harness.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

test("GET /control/energy-prices is the downloads' state; POST …/refresh downloads and answers when stored", async () => {
  const g = await startGateway({
    priceSource: async (url) => {
      if (url === EIA_URL) return fs.readFileSync(path.join(FIXTURES, "eia-table-5-6-a.html"), "utf8");
      throw new Error("HTTP 503");
    },
  });
  try {
    const idle = await g.control("GET", "/control/energy-prices");
    assert.equal(idle.status, 200);
    assert.deepEqual(JSON.parse(idle.body), {
      eia: { at: null, okAt: null, rows: 0, error: null },
      eurostat: { at: null, okAt: null, rows: 0, error: null },
    });
    const refreshed = await g.control("POST", "/control/energy-prices/refresh");
    assert.equal(refreshed.status, 200);
    const status = JSON.parse(refreshed.body) as Record<string, { rows: number; error: string | null }>;
    assert.equal(status.eia?.rows, 102);
    assert.equal(status.eurostat?.error, "HTTP 503");
    assert.equal(g.db.select().from(energyPrices).all().length, 102);
    assert.equal((await g.control("GET", "/control/energy-prices/refresh")).status, 405);
    assert.equal((await g.control("POST", "/control/energy-prices/refresh", undefined, "wrong")).status, 401);
  } finally {
    await g.close();
  }
});
