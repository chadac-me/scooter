/**
 * Contract test for the scooter.uploads caps the agent-host reads from its env
 * (FILE_MAX_BYTES / FILE_MAX_PER_MESSAGE) and the per-message file-count check.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILE_MAX_BYTES,
  DEFAULT_FILE_MAX_PER_MESSAGE,
  assertFileCount,
  uploadLimitsFromEnv,
} from "../../src/config/uploads.js";

describe("upload limits", () => {
  it("defaults to 25MB per file and 4 files per message", () => {
    expect(uploadLimitsFromEnv({})).toEqual({ maxFileBytes: 25 * 1024 * 1024, maxFilesPerMessage: 4 });
    expect(DEFAULT_FILE_MAX_BYTES).toBe(26214400);
    expect(DEFAULT_FILE_MAX_PER_MESSAGE).toBe(4);
  });

  it("reads both caps from the env", () => {
    expect(uploadLimitsFromEnv({ FILE_MAX_BYTES: "104857600", FILE_MAX_PER_MESSAGE: "2" })).toEqual({
      maxFileBytes: 104857600,
      maxFilesPerMessage: 2,
    });
  });

  it("falls back to the defaults for empty, zero, negative or non-integer values", () => {
    for (const bad of ["", "0", "-5", "1.5", "lots"]) {
      expect(uploadLimitsFromEnv({ FILE_MAX_BYTES: bad, FILE_MAX_PER_MESSAGE: bad })).toEqual({
        maxFileBytes: DEFAULT_FILE_MAX_BYTES,
        maxFilesPerMessage: DEFAULT_FILE_MAX_PER_MESSAGE,
      });
    }
  });

  it("allows up to the per-message count and rejects one more with a readable error", () => {
    const limits = { maxFileBytes: 10, maxFilesPerMessage: 2 };
    expect(() => assertFileCount(undefined, limits)).not.toThrow();
    expect(() => assertFileCount([{}, {}], limits)).not.toThrow();
    expect(() => assertFileCount([{}, {}, {}], limits)).toThrow(
      "this message has 3 file attachments, but at most 2 are allowed per message",
    );
  });
});
