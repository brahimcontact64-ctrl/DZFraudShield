import { getDashboardSessionUser } from "@/lib/auth/session-server";
import { createClient } from "@/lib/supabase/server";
import { unstable_noStore as noStore } from "next/cache";

/**
 * Single source of truth for resolving the current merchant.
 *
 * 1. Reads the authenticated user from the session cookie.
 * 2. Finds the merchant owned by that user.
 * 3. Returns the merchant row, or null if not authenticated.
 *
 * No bootstrap fallback. No email reclaim. No global lookup.
 */
export async function resolveCurrentMerchant(): Promise<{
  id: string;
  name: string | null;
  email: string | null;
} | null> {
  noStore();
  const user = await getDashboardSessionUser();
  if (!user) {
    return null;
  }

  const supabase = createClient();
  const { data } = await supabase
    .from("merchants")
    .select("id, name, email")
    .eq("owner_user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  return data ?? null;
}
