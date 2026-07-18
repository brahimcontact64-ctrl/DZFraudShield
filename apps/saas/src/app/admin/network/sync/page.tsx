import { getNetworkSyncReports } from "@/lib/delivery-intelligence/historical-sync";
import { getSyncableDeliveryAccounts } from "@/lib/delivery-intelligence/accounts";
import { NetworkSyncClient } from "./sync-client";
import { AdminSectionHeader } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

export default async function NetworkSyncPage() {
  const [reports, accounts] = await Promise.all([
    getNetworkSyncReports().catch(() => []),
    getSyncableDeliveryAccounts().catch(() => []),
  ]);

  const yalidineAccounts = accounts.filter((a) => a.provider === "yalidine");
  const zrAccounts = accounts.filter((a) => a.provider === "zr_express");

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-6 py-8">
      <AdminSectionHeader
        title="Network Sync"
        description="Import historical delivery data into the reputation network. Both providers feed the same unified customer profiles."
      />

      {/* Connected accounts summary */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "Yalidine Accounts", value: yalidineAccounts.length },
          { label: "ZR Express Accounts", value: zrAccounts.length },
          { label: "Total Syncs", value: reports.length },
          {
            label: "Last Sync",
            value: reports[0]
              ? new Date(reports[0].completed_at).toLocaleDateString("fr-DZ")
              : "Never",
          },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10"
          >
            <p className="text-[11px] uppercase tracking-widest text-slate-400">{label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-white">{value}</p>
          </div>
        ))}
      </div>

      <NetworkSyncClient initialReports={reports} />
    </div>
  );
}
