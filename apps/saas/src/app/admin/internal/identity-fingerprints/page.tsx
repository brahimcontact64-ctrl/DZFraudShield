import { getIdentityFingerprintDashboard } from "@/lib/delivery-intelligence/dashboard";
import { AdminBadge, AdminPanel, AdminSectionHeader } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

export default async function AdminIdentityFingerprintsPage() {
  const fingerprints = await getIdentityFingerprintDashboard();

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <AdminBadge tone="violet">Internal</AdminBadge>
        <h1 className="text-2xl font-semibold text-white">Identity Fingerprints</h1>
        <p className="text-sm text-slate-400">
          Global identity linkage fingerprints across the merchant network.
        </p>
      </div>

      <AdminPanel className="space-y-4">
        <AdminSectionHeader
          title="Fingerprint links"
          description={`${fingerprints.length} fingerprints indexed`}
        />
        {fingerprints.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">No fingerprints indexed yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-700/40">
            <table className="min-w-full text-sm">
              <thead className="border-b border-slate-700/40 bg-slate-800/40">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Fingerprint
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Confidence
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Linked identities
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/30">
                {fingerprints.map((fp) => (
                  <tr key={fp.id} className="transition hover:bg-slate-800/30">
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">
                      {fp.fingerprint_hash?.slice(0, 20) ?? "—"}…
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {Number(fp.confidence_score).toFixed(2)}%
                    </td>
                    <td className="px-4 py-3 text-slate-300">
                      {(fp.identity_links as Array<{ count: number }>)?.[0]?.count ?? 0}
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(fp.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminPanel>
    </div>
  );
}
