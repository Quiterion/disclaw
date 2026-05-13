import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration, formatDuration } from "../src/duration.js";

test("parseDuration: seconds with various unit aliases", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("30sec"), 30_000);
  assert.equal(parseDuration("30seconds"), 30_000);
  assert.equal(parseDuration("30"), 30_000); // bare number defaults to seconds
});

test("parseDuration: minutes", () => {
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("5min"), 300_000);
  assert.equal(parseDuration("5minutes"), 300_000);
});

test("parseDuration: hours and fractional", () => {
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("1.5h"), 5_400_000);
  assert.equal(parseDuration("0.5hours"), 1_800_000);
});

test("parseDuration: off / none / never → null", () => {
  assert.equal(parseDuration("off"), null);
  assert.equal(parseDuration("none"), null);
  assert.equal(parseDuration("never"), null);
  assert.equal(parseDuration("OFF"), null); // case-insensitive
});

test("parseDuration: case + whitespace tolerance", () => {
  assert.equal(parseDuration("  30S  "), 30_000);
  assert.equal(parseDuration("5 M"), 300_000);
});

test("parseDuration: rejects garbage", () => {
  assert.throws(() => parseDuration(""));
  assert.throws(() => parseDuration("forever"));
  assert.throws(() => parseDuration("30 minutes ago"));
  assert.throws(() => parseDuration("abc"));
});

test("formatDuration round-trips reasonably", () => {
  assert.equal(formatDuration(null), "off");
  assert.equal(formatDuration(30_000), "30s");
  assert.equal(formatDuration(300_000), "5m");
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(5_400_000), "1.5h");
});
