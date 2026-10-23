/** The pg pool's outage handling: a configurable connect timeout, outage classification, and one retry for idempotent reads. */

import { describe, it, expect, vi } from "vitest";

import { DbUnavailableError, isDbUnavailable, pgConnectTimeoutMs, retryReadOnce } from "../../src/db/pgPool.js";

describe("pgPool", () => {
  it("defaults the connect timeout to 15s and honours PG_CONNECT_TIMEOUT_MS", () => {
    expect(pgConnectTimeoutMs({})).toBe(15_000);
    expect(pgConnectTimeoutMs({ PG_CONNECT_TIMEOUT_MS: "30000" })).toBe(30_000);
    expect(pgConnectTimeoutMs({ PG_CONNECT_TIMEOUT_MS: "nope" })).toBe(15_000);
  });

  it("classifies an outage, including one wrapped as a cause, but not a bad query", () => {
    expect(isDbUnavailable(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isDbUnavailable(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isDbUnavailable(Object.assign(new Error("shutting down"), { code: "57P01" }))).toBe(true);
    expect(isDbUnavailable(new Error("Failed query", { cause: new Error("Connection terminated unexpectedly") }))).toBe(true);
    expect(isDbUnavailable(Object.assign(new Error("syntax"), { code: "42601" }))).toBe(false);
    expect(isDbUnavailable(Object.assign(new Error("dup"), { code: "23505" }))).toBe(false);
  });

  it("retries an idempotent read ONCE across an outage", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("timeout exceeded when trying to connect"))
      .mockResolvedValueOnce("rows");
    await expect(retryReadOnce("listLinks", run, 0)).resolves.toBe("rows");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry with a DbUnavailableError the HTTP layer maps to 503", async () => {
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("Connection terminated"));
    await expect(retryReadOnce("listLinks", run, 0)).rejects.toBeInstanceOf(DbUnavailableError);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not retry a query error", async () => {
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(Object.assign(new Error("bad"), { code: "42P01" }));
    await expect(retryReadOnce("listLinks", run, 0)).rejects.toThrow("bad");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
