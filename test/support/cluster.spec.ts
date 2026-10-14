import { describe, expect, it } from "vitest";

import { curlPodBody, curlPodWithRetry, parseLeadingJson } from "./cluster.js";

const run = (...stdouts: Array<{ stdout: string; stderr?: string; tookMs?: number }>) => {
  const calls: number[] = [];
  const attempt = async (n: number) => {
    calls.push(n);
    const next = stdouts[Math.min(n - 1, stdouts.length - 1)];
    if (next.tookMs) await new Promise((r) => setTimeout(r, next.tookMs));
    return { stdout: next.stdout, stderr: next.stderr ?? "" };
  };
  return { attempt, calls };
};

const DELETED = 'pod "curltest-abc-1" deleted\n';

describe("curlPodBody", () => {
  it("strips the teardown line kubectl appends after the payload", () => {
    expect(curlPodBody(`{"id":"c1"}\n${DELETED}`)).toBe('{"id":"c1"}');
  });

  it("is empty when the attach returned the teardown line and nothing else", () => {
    expect(curlPodBody(DELETED)).toBe("");
  });

  it("keeps a body that itself contains the word deleted", () => {
    expect(curlPodBody(`{"status":"deleted"}\n${DELETED}`)).toBe('{"status":"deleted"}');
  });
});

describe("curlPodWithRetry", () => {
  it("returns the first non-empty body without retrying", async () => {
    const { attempt, calls } = run({ stdout: `{"id":"c1"}\n${DELETED}` });
    await expect(curlPodWithRetry(attempt, "curl GET /x", { delayMs: 0 })).resolves.toBe('{"id":"c1"}');
    expect(calls).toEqual([1]);
  });

  it("runs a fresh pod when the attach streamed no body, and returns the later answer", async () => {
    const { attempt, calls } = run(
      { stdout: DELETED },
      { stdout: DELETED },
      { stdout: `[{"id":"c1"}]\n${DELETED}` },
    );
    await expect(curlPodWithRetry(attempt, "curl GET /x", { delayMs: 0 })).resolves.toBe('[{"id":"c1"}]');
    expect(calls).toEqual([1, 2, 3]);
  });

  it("gives up after the attempt budget, naming the request and the last stderr", async () => {
    const { attempt, calls } = run({ stdout: DELETED, stderr: "error: timed out waiting for the condition" });
    await expect(
      curlPodWithRetry(attempt, "curl POST http://host/conversations", { attempts: 3, delayMs: 0 }),
    ).rejects.toThrow(
      /curl POST http:\/\/host\/conversations: the curl pod returned no response body in 3 attempt\(s\) over \d+s; last stderr: error: timed out waiting for the condition/,
    );
    expect(calls).toEqual([1, 2, 3]);
  });

  it("does not retry an attempt that spent the time budget, so a real empty answer fails fast", async () => {
    const { attempt, calls } = run({ stdout: DELETED, tookMs: 30 });
    await expect(
      curlPodWithRetry(attempt, "curl POST /agui", { attempts: 3, delayMs: 0, budgetMs: 20 }),
    ).rejects.toThrow(/no response body in 1 attempt\(s\)/);
    expect(calls).toEqual([1]);
  });
});

describe("parseLeadingJson", () => {
  it("parses a payload the curl pod followed with a stray line", () => {
    expect(parseLeadingJson<{ id: string }>('{"id":"c1"}\nSomething else')).toEqual({ id: "c1" });
  });

  it("rethrows the original error when no prefix parses", () => {
    expect(() => parseLeadingJson("")).toThrow(SyntaxError);
  });
});
