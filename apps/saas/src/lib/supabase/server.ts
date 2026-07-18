import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export function createClient() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRole) {
    throw new Error("Missing Supabase environment variables");
  }

  return createSupabaseClient(url, serviceRole, {
    auth: { persistSession: false },
    global: {
      // Opt out of Next.js 14 Data Cache — the patched global fetch caches supabase
      // POST-gREST reads, which breaks live-status polling and fire-and-forget sync.
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  });
}
