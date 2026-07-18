"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { generateApiKey } from "@/lib/security/hash";
import { hashApiKeyForStorage } from "@/lib/security/api-key";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";

export async function createApiKeyAction() {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return { error: "No merchant found" };
  }

  const plainKey = generateApiKey();
  const keyHash = hashApiKeyForStorage(plainKey);
  const prefix = plainKey.slice(0, 10);

  const supabase = createClient();
  const { error } = await supabase.from("merchant_api_keys").insert({
    merchant_id: merchantId,
    key_name: `Key ${new Date().toISOString()}`,
    key_prefix: prefix,
    api_key_hash: keyHash,
    is_active: true
  });

  if (error) {
    return { error: error.message };
  }

  await supabase.from("audit_logs").insert({
    merchant_id: merchantId,
    action: "api_key_created",
    actor_type: "dashboard",
    payload: { keyPrefix: prefix }
  });

  revalidatePath("/dashboard/api-keys");
  return { key: plainKey };
}
