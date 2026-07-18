import { createClient } from "@/lib/supabase/server";
import { AdminBadge, AdminPanel, AdminSectionHeader } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

export default async function AdminRiskEventsPage() {
  const supabase = createClient();
  const { data } = await supabase
    .from("risk_events")
    .select("id, event_type, merchant_id, created_at, payload, order_check_id")
    .order("created_at", { ascending: false })
    .limit(100);

  const events = data ?? [];

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <AdminBadge tone="rose">Internal</AdminBadge>
        <h1 className="text-2xl font-semibold text-white">Risk Events</h1>
        <p className="text-sm text-slate-400">
          Network-wide risk events across all merchants, most recent first.
        </p>
      </div>

      <AdminPanel className="space-y-4">
        <AdminSectionHeader
          title="Latest events"
          description={`${events.length} most recent risk events`}
        />
        {events.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">No risk events found.</p>
        ) : (
          <ul className="space-y-2">
            {events.map((event) => {
              const payload = (event.payload ?? {}) as Record<string, unknown>;
              const riskScore = payload.riskScore ?? payload.risk_score ?? "—";
              const riskLevel = payload.riskLevel ?? payload.risk_level ?? "—";

              return (
                <li
                  key={event.id}
                  className="rounded-xl border border-slate-700/40 bg-slate-800/30 p-4"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm font-semibold text-slate-200">
                      {event.event_type}
                    </span>
                    <span className="text-xs text-slate-500">
                      {new Date(event.created_at).toLocaleString()}
                    </span>
                    <span className="text-xs text-slate-500">
                      Merchant: {event.merchant_id?.slice(0, 8)}…
                    </span>
                    <span className="rounded-full bg-rose-900/40 px-2 py-0.5 text-[11px] font-semibold text-rose-300 ring-1 ring-rose-700/30">
                      Score: {String(riskScore)}
                    </span>
                    <span className="rounded-full bg-amber-900/40 px-2 py-0.5 text-[11px] font-semibold text-amber-300 ring-1 ring-amber-700/30">
                      {String(riskLevel)}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-slate-500">
                    Order check: {event.order_check_id ?? "—"}
                  </p>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-medium text-slate-400 hover:text-slate-200">
                      Event metadata
                    </summary>
                    <pre className="mt-2 overflow-x-auto rounded-lg border border-slate-700/40 bg-slate-900/60 p-3 text-xs text-slate-400">
                      {JSON.stringify(payload, null, 2)}
                    </pre>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </AdminPanel>
    </div>
  );
}
