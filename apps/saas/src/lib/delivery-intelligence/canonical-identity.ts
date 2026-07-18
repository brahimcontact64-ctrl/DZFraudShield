import { createClient } from "@/lib/supabase/server";

/**
 * Walks the canonical_identity_id chain on customer_identity and returns the
 * canonical (authoritative) identity id.
 *
 * The BEFORE INSERT trigger (migration 000003) sets canonical_identity_id = id
 * for every new row. Merge operations update canonical_identity_id eagerly on
 * the source row, so 1 hop is typical; 4 is a safe ceiling against corrupted
 * chains.
 *
 * Returns identityId unchanged when:
 *   - the row is already canonical (canonical_identity_id = id), or
 *   - the row is not found (safe no-op — caller writes what it had).
 *
 * Throws on any Supabase read error so callers cannot silently write stale ids.
 *
 * This module has no project-internal imports so it can be imported by any
 * module without creating circular dependencies.
 */
export async function resolveCanonicalIdentity(
  supabase: ReturnType<typeof createClient>,
  identityId: string,
): Promise<string> {
  const MAX_HOPS = 4;
  let currentId = identityId;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const { data, error } = await supabase
      .from("customer_identity")
      .select("canonical_identity_id")
      .eq("id", currentId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return currentId;

    const row = data as { canonical_identity_id: string | null };
    const canonical = row.canonical_identity_id;

    if (!canonical || canonical === currentId) {
      return currentId;
    }
    currentId = canonical;
  }

  console.warn(
    `[canonical-identity] merge chain exceeded ${MAX_HOPS} hops from origin=${identityId}; resolving to ${currentId}`,
  );
  return currentId;
}
