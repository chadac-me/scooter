/**
 * Parse the SCOOTER_ENV channel, the deployment's extra sandbox env vars that the
 * agent-host sets on every sandbox pod. The value is JSON, which round-trips every
 * value losslessly including multi-line ones; a flat `k=v;k=v` form is also accepted
 * but cannot carry a newline or `;` in a value.
 */
export interface EnvVar {
  name: string;
  value: string;
}

export function parseScooterEnv(raw: string | undefined): EnvVar[] {
  const s = (raw ?? "").trim();
  if (!s) return [];

  // Anything that opens like JSON is treated as JSON: a well-formed object yields its
  // entries and anything else yields [].
  if (/^[{["]/.test(s)) {
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      return [];
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
    return Object.entries(obj as Record<string, unknown>)
      // Coerce each value to a string.
      .map(([name, value]) => ({ name, value: String(value ?? "") }))
      .filter((e) => e.name);
  }

  // The k=v;k=v form, where only the chunk boundaries are trimmed so a value is preserved as-is after the first `=`.
  return s
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf("=");
      return i < 0 ? { name: kv, value: "" } : { name: kv.slice(0, i), value: kv.slice(i + 1) };
    })
    .filter((e) => e.name);
}
