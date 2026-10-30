/**
 * Each contrib's resourceType spellings -> the one `resource_links` stores, rendered by
 * modules/platform.nix as LINK_TYPE_ALIASES_JSON: source -> { alias: canonical }.
 */

export type LinkTypeAliases = Record<string, Record<string, string>>;

/** The table in `raw`, keeping only string rows; unset or malformed JSON is an empty table. */
export function parseLinkTypeAliases(raw: string | undefined, warn?: (msg: string) => void): LinkTypeAliases {
  if (!raw || !raw.trim()) return {};
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    warn?.("LINK_TYPE_ALIASES_JSON is not valid JSON; link types are stored as written");
    return {};
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return {};
  const out: LinkTypeAliases = {};
  for (const [source, table] of Object.entries(doc as Record<string, unknown>)) {
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    const rows = Object.entries(table as Record<string, unknown>).filter(
      (row): row is [string, string] => typeof row[1] === "string",
    );
    out[source] = Object.fromEntries(rows.map(([alias, canonical]) => [alias.toLowerCase(), canonical]));
  }
  return out;
}

/** The stored spelling of `resourceType`; a source or type with no alias passes through unchanged. */
export function canonicalResourceType(aliases: LinkTypeAliases, source: string, resourceType: string): string {
  return aliases[source]?.[resourceType.toLowerCase()] ?? resourceType;
}
