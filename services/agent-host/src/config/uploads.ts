/**
 * Upload caps for file attachments (non-image), set by the platform from
 * `scooter.uploads` and served to the UI in /whoami's `limits` block. The ui
 * nginx body limit is derived from the same two numbers, so the defaults here must
 * match the platform's and the UI's.
 */

/** Default per-file cap (~25MB). */
export const DEFAULT_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** Default cap on file attachments per message. */
export const DEFAULT_FILE_MAX_PER_MESSAGE = 4;

export interface UploadLimits {
  maxFileBytes: number;
  maxFilesPerMessage: number;
}

/** A positive integer from the env, else the fallback (unset, empty, 0 or junk). */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Read FILE_MAX_BYTES / FILE_MAX_PER_MESSAGE. */
export function uploadLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): UploadLimits {
  return {
    maxFileBytes: positiveInt(env.FILE_MAX_BYTES, DEFAULT_FILE_MAX_BYTES),
    maxFilesPerMessage: positiveInt(env.FILE_MAX_PER_MESSAGE, DEFAULT_FILE_MAX_PER_MESSAGE),
  };
}

/** Throw a readable error when a message carries more files than allowed. */
export function assertFileCount(files: readonly unknown[] | undefined, limits: UploadLimits): void {
  const n = files?.length ?? 0;
  if (n > limits.maxFilesPerMessage) {
    throw new Error(
      `this message has ${n} file attachments, but at most ${limits.maxFilesPerMessage} are allowed per message`,
    );
  }
}
