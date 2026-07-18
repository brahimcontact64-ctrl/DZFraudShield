import { createClient } from "@/lib/supabase/server";
import { AdminBadge, AdminPanel, AdminSectionHeader, FlowList } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

function summarizePayload(payload: Record<string, unknown> | null | undefined) {
  if (!payload) {
    return "No payload";
  }

  const source = String(payload.source ?? payload.origin ?? payload.route ?? payload.channel ?? "admin console");
  const location = String(payload.ip_address ?? payload.ip ?? payload.ipAddress ?? payload.from ?? "unknown origin");
  return `${source} · ${location}`;
}

export default async function AdminAuditPage() {
  const supabase = createClient();
  const [logsResult, merchantsResult] = await Promise.all([
    supabase.from("audit_logs").select("id, merchant_id, actor_type, actor_id, action, payload, created_at").order("created_at", { ascending: false }).limit(120),
    supabase.from("merchants").select("id, name")
  ]);

  if (logsResult.error) throw logsResult.error;
  if (merchantsResult.error) throw merchantsResult.error;

  const merchantNameById = new Map((merchantsResult.data ?? []).map((row) => [row.id, row.name]));
  const logs = (logsResult.data ?? []).map((log) => ({
    title: log.action,
    subtitle: `${merchantNameById.get(log.merchant_id ?? "") ?? "Global"} · ${log.actor_type}${log.actor_id ? ` · ${log.actor_id}` : ""}`,
    meta: new Date(log.created_at).toLocaleString(),
    tone: "sky" as const,
    payloadSummary: summarizePayload((log.payload ?? {}) as Record<string, unknown>)
  }));

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <AdminBadge tone="sky">Audit Logs</AdminBadge>
        <h1 className="text-2xl font-semibold text-white">Audit Logs</h1>
        <p className="max-w-3xl text-sm text-slate-400">Who changed what, when it happened, and from which source the action originated.</p>
      </div>

      <AdminPanel className="space-y-4">
        <AdminSectionHeader eyebrow="Timeline" title="Recent admin events" description="Chronological record of platform operations and security actions." />
        <FlowList
          emptyLabel="No audit events recorded yet."
          items={logs.slice(0, 20).map((log) => ({
            title: log.title,
            subtitle: `${log.subtitle} · ${log.payloadSummary}`,
            meta: log.meta,
            tone: "sky"
          }))}
        />
      </AdminPanel>
    </div>
  );
}