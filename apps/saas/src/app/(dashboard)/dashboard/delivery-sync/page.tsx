import { redirect } from "next/navigation";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { getMerchantSyncStatus } from "@/lib/delivery-intelligence/merchant-delivery-sync";
import { MerchantDeliverySyncPanel } from "./MerchantDeliverySyncPanel";

export const dynamic = "force-dynamic";

export default async function DeliverySyncPage() {
  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    redirect("/auth/login");
  }

  const status = await getMerchantSyncStatus(merchantId);

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#D6A74C]">Delivery</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Delivery Data Sync</h1>
        <p className="mt-1 text-sm text-slate-500">
          Sync wilayas, communes, stop desks, and shipping prices from your Yalidine account.
          Prices fetched here are used automatically when calculating delivery costs for your orders.
        </p>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
        <h2 className="mb-1 text-base font-semibold text-slate-900">Yalidine Sync</h2>
        <p className="mb-5 text-sm text-slate-500">
          Uses your Yalidine API credentials. Data is stored per-account and does not affect other merchants.
        </p>
        <MerchantDeliverySyncPanel initialStatus={status} />
      </div>

      <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6 text-sm text-slate-500 space-y-2">
        <p className="font-semibold text-slate-700">How it works</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>Geo data (wilayas, communes, stop desks) is fetched once and cached.</li>
          <li>Prices are synced per origin wilaya — all 58 wilayas are processed.</li>
          <li>Rate limits are respected automatically (5 req/s, 50 req/min).</li>
          <li>You can stop and resume at any time — failed origins can be retried independently.</li>
          <li>Use <strong>Update Prices</strong> to refresh prices without re-fetching geo data.</li>
        </ul>
      </div>
    </div>
  );
}
