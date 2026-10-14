/**
 * Email normalization for identity matching, so one person maps to one Scooter user
 * whatever cosmetic form a provider hands us: lowercase, trim, and drop a `+tag`
 * sub-address. Dots are not stripped, since `a.b@` and `ab@` are different people at
 * most providers. Used on both sides of the id-to-email mapping in identityStore.
 */

/** Normalize an email for identity matching, returning "" for blank input and only lowercasing a string without an "@". */
export function normalizeEmail(email: string | null | undefined): string {
  const trimmed = (email ?? "").trim().toLowerCase();
  if (!trimmed) return "";
  const at = trimmed.lastIndexOf("@");
  // Not a normal address, so just lowercase and trim.
  if (at <= 0 || at === trimmed.length - 1) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  // Drop the +tag sub-address.
  const plus = local.indexOf("+");
  const baseLocal = plus === -1 ? local : local.slice(0, plus);
  // A local part that is only a tag keeps its original form rather than becoming "@domain".
  const finalLocal = baseLocal || local;
  return `${finalLocal}@${domain}`;
}
