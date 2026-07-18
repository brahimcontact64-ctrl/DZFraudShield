import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { AdminBadge, AdminPanel, AdminSectionHeader } from "@/components/admin/admin-ui";
import { getGlobalDeliverySyncStatus } from "@/lib/delivery-intelligence/global-delivery-cache";
import { DeliveryCacheSyncPanel } from "./DeliveryCacheSyncPanel";

export const dynamic = "force-dynamic";

export default async function AdminDeliveryCachePage() {
  const supabase = createClient();

  const [globalStatus, providersResult] = await Promise.all([
    getGlobalDeliverySyncStatus(),
    supabase
      .from("delivery_providers")
      .select("code,name,last_sync_at,updated_at")
      .order("code", { ascending: true }),
  ]);

  const providers = providersResult.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <AdminBadge tone="emerald">Delivery Cache</AdminBadge>
          <h1 className="text-3xl font-semibold text-white">Global delivery cache</h1>
          <p className="max-w-3xl text-sm text-slate-300">
            Shared Yalidine geo and pricing data used by all merchants at checkout.
            Only admins can refresh this cache — merchants never call Yalidine for pricing.
          </p>
        </div>
        <Link
          href="/admin"
          className="rounded-full border border-slate-700/40 bg-slate-800/40 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700/40"
        >
          Back
        </Link>
      </div>

      {/* Global cache — interactive sync panel (client component with live progress) */}
      <AdminPanel className="bg-white/6 text-slate-50">
        <AdminSectionHeader
          eyebrow="Global Cache"
          title="Yalidine shared cache"
          description="Populated by admin sync. All merchants read from these tables."
        />
        <div className="mt-4">
          <DeliveryCacheSyncPanel initialStatus={globalStatus} />
        </div>
      </AdminPanel>

      {/* Legacy per-provider table — kept for non-yalidine providers */}
      {providers.length > 0 && (
        <AdminPanel className="bg-white/6 text-slate-50">
          <AdminSectionHeader
            eyebrow="Providers"
            title="Per-provider delivery cache"
            description="Non-Yalidine providers that still use per-merchant caches."
          />
          <div className="mt-4 overflow-hidden rounded-xl border border-slate-700/40">
            <div className="grid grid-cols-4 bg-[#0C1724] px-4 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-slate-300">
              <div>Provider</div>
              <div>Code</div>
              <div>Last Sync</div>
              <div>Updated At</div>
            </div>
            {providers.map((provider) => (
              <div
                key={provider.code}
                className="grid grid-cols-4 border-t border-slate-700/40 bg-slate-800/40 px-4 py-3 text-sm text-slate-100"
              >
                <div>{provider.name}</div>
                <div className="font-mono text-xs uppercase tracking-wide text-slate-300">
                  {provider.code}
                </div>
                <div>
                  {provider.last_sync_at
                    ? new Date(provider.last_sync_at).toLocaleString()
                    : "Never"}
                </div>
                <div>
                  {provider.updated_at
                    ? new Date(provider.updated_at).toLocaleString()
                    : "-"}
                </div>
              </div>
            ))}
          </div>
        </AdminPanel>
      )}
    </div>
  );
}
