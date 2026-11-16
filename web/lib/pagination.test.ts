import assert from "node:assert/strict";
import test from "node:test";
import { clampPage, pageCount, pageSlice, pageSummary, pageWindow, parsePage, parsePageSize } from "./pagination.ts";

test("pageCount: at least one page", () => {
  assert.equal(pageCount(0, 30), 1);
  assert.equal(pageCount(30, 30), 1);
  assert.equal(pageCount(31, 30), 2);
});

test("clampPage keeps a page within the rows there are", () => {
  assert.equal(clampPage(5, 31, 30), 2);
  assert.equal(clampPage(0, 31, 30), 1);
  assert.equal(clampPage(Number.NaN, 31, 30), 1);
});

test("pageSlice and pageSummary", () => {
  assert.deepEqual(pageSlice(2, 20, 21), { start: 20, end: 21 });
  assert.equal(pageSummary(1, 20, 21), "1–20 of 21");
  assert.equal(pageSummary(2, 20, 21), "21–21 of 21");
  assert.equal(pageSummary(1, 30, 0), "0 of 0");
  assert.equal(pageSummary(1, 30, 1234), "1–30 of 1,234");
});

test("pageWindow: every page up to 7, then first, last and the current one's neighbours", () => {
  assert.deepEqual(pageWindow(1, 2), [1, 2]);
  assert.deepEqual(pageWindow(1, 12), [1, 2, 3, 4, 5, "ellipsis", 12]);
  assert.deepEqual(pageWindow(6, 12), [1, "ellipsis", 5, 6, 7, "ellipsis", 12]);
  assert.deepEqual(pageWindow(11, 12), [1, "ellipsis", 8, 9, 10, 11, 12]);
});

test("URL values: unknown sizes and bad pages fall back", () => {
  assert.equal(parsePageSize("50"), 50);
  assert.equal(parsePageSize("7"), 30);
  assert.equal(parsePageSize(undefined), 30);
  assert.equal(parsePage("3"), 3);
  assert.equal(parsePage("-1"), 1);
  assert.equal(parsePage(["2", "9"]), 2);
});
