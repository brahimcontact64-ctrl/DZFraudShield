import { createClient } from "@/lib/supabase/server";
import { getIdentityFingerprintDashboard } from "@/lib/delivery-intelligence/dashboard";
import { getNetworkOverview } from "@/lib/admin/network";
import { hashWithSecret } from "@/lib/security/hash";
import { normalizeAlgerianPhone } from "@/lib/security/phone";
import { normalizeAddress } from "@/lib/delivery-intelligence/normalize";
import { AdminBadge, AdminMetricCard, AdminPanel, AdminSectionHeader, FlowList } from "@/components/admin/admin-ui";

export const dynamic = "force-dynamic";

type RawTopRiskCustomer = {
  identity_id: string;
  reputation_score: number;
  risk_level: string;
  total_orders: number;
  returned_orders: number;
  refused_orders: number;
  merchant_count: number;
};

type TopRiskCustomer = {
  identityId: string;
  customerName: string | null;
  riskLevel: "NORMAL" | "WATCHLIST" | "HIGH_RISK" | "BLACKLIST";
  refusedOrders: number;
  merchantCount: number;
  estimatedDamageDzd: number;
  totalOrders: number;
  deliverySuccessRate: number;
};

type RawWilayaRow = { wilaya: string; orders: number; return_rate: number; delivery_rate: number };
type TopRiskPhone = { phoneHash: string; totalOrders: number; problematicOrders: number; riskRatio: number };
type TopRiskAddress = { address: string; totalOrders: number; problematicOrders: number; riskRatio: number };
type FingerprintRow = { id: string; fingerprint_hash: string; confidence_score: number; created_at: string; identity_links?: Array<{ count: number }> };

type Tab = "reputation" | "fingerprints" | "merchant" | "fraud";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "reputation",   label: "Customer Reputation" },
  { key: "fingerprints", label: "Identity Fingerprints" },
  { key: "merchant",     label: "Merchant Network" },
  { key: "fraud",        label: "Fraud Graph" },
];

type SearchParams = { tab?: string; phone?: string; name?: string; address?: string };

export default async function AdminNetworkPage({ searchParams }: { searchParams?: SearchParams }) {
  const tab = (searchParams?.tab as Tab) ?? "reputation";
  const supabase = createClient();

  const overview = await getNetworkOverview();

  const topRiskCustomers = ((overview.topRiskCustomers ?? []) as unknown as RawTopRiskCustomer[]).map((row) => ({
    identityId: row.identity_id,
    customerName: null as string | null,
    riskLevel: (row.risk_level === "BLACKLIST" || row.reputation_score <= 25
      ? "BLACKLIST"
      : row.reputation_score <= 45 ? "HIGH_RISK"
      : row.reputation_score <= 70 ? "WATCHLIST"
      : "NORMAL") as TopRiskCustomer["riskLevel"],
    refusedOrders: Number(row.refused_orders ?? 0),
    merchantCount: Number(row.merchant_count ?? 0),
    estimatedDamageDzd: Number(row.refused_orders ?? 0) * 1500,
    totalOrders: Number(row.total_orders ?? 0),
    deliverySuccessRate: Number(row.total_orders ?? 0)
      ? Math.round(((Number(row.total_orders) - Number(row.returned_orders ?? 0) - Number(row.refused_orders ?? 0)) / Number(row.total_orders)) * 100)
      : 0,
  }));

  const topRiskPhones    = (overview.topRiskPhones ?? []) as TopRiskPhone[];
  const topRiskAddresses = (overview.topRiskAddresses ?? []) as TopRiskAddress[];
  const topWilayaRankings = (overview.topWilayaRankings ?? []) as RawWilayaRow[];

  const deliveryTrendResult = await supabase
    .from("delivery_orders")
    .select("synced_at, status")
    .gte("synced_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    .order("synced_at", { ascending: true });

  const trendByDay = new Map<string, number>();
  for (const row of deliveryTrendResult.data ?? []) {
    const day = new Date(row.synced_at).toISOString().slice(0, 10);
    trendByDay.set(day, (trendByDay.get(day) ?? 0) + 1);
  }
  const trend = Array.from(trendByDay.values());

  let fingerprints: FingerprintRow[] = [];
  if (tab === "fingerprints") {
    fingerprints = ((await getIdentityFingerprintDashboard()) ?? []) as FingerprintRow[];
  }

  type IdentityRow = { id: string; phone_hash: string; customer_name: string | null; normalized_address: string | null; wilaya: string | null; commune: string | null; updated_at: string };
  type OrderRow = { identity_id: string | null; merchant_id: string | null; provider: string; status: string; order_amount: string | null; synced_at: string };
  type ReputationRow = { identity_id: string; total_orders: number; delivered_orders: number; returned_orders: number; refused_orders: number; cancelled_orders: number; merchant_count: number; reputation_score: number; risk_level: string; updated_at: string };

  type SearchResult = {
    identity: IdentityRow;
    reputation: ReputationRow | null;
    merchantHistoryRows: Array<{ merchantName: string; total: number; failed: number; returned: number; refused: number; lastSeen: string }>;
    recentOrders: Array<{ title: string; subtitle: string; meta: string; tone: "rose" | "emerald" }>;
    failedDeliveries: number;
    networkDamage: number;
  };

  let searchResults: SearchResult[] = [];
  const phoneQuery = searchParams?.phone?.trim() ?? "";
  const nameQuery  = searchParams?.name?.trim() ?? "";
  const addrQuery  = searchParams?.address?.trim() ?? "";
  const hasSearch  = !!(phoneQuery || nameQuery || addrQuery);

  if (tab === "reputation" && hasSearch) {
    const phoneSecret = process.env.PHONE_HASH_SECRET ?? "";
    const normalizedPhone = phoneQuery ? normalizeAlgerianPhone(phoneQuery) ?? phoneQuery : "";
    const phoneHash = normalizedPhone && phoneSecret ? hashWithSecret(normalizedPhone, phoneSecret) : "";
    const normalizedAddress = addrQuery ? normalizeAddress(addrQuery) : "";

    const identityQueries: Array<PromiseLike<{ data: IdentityRow[] | null; error: Error | null }>> = [];
    if (phoneHash) identityQueries.push(supabase.from("customer_identity").select("id, phone_hash, customer_name, normalized_address, wilaya, commune, updated_at").eq("phone_hash", phoneHash).limit(20));
    if (nameQuery) identityQueries.push(supabase.from("customer_identity").select("id, phone_hash, customer_name, normalized_address, wilaya, commune, updated_at").ilike("customer_name", `%${nameQuery}%`).limit(20));
    if (normalizedAddress) identityQueries.push(supabase.from("customer_identity").select("id, phone_hash, customer_name, normalized_address, wilaya, commune, updated_at").ilike("normalized_address", `%${normalizedAddress}%`).limit(20));
    if (!identityQueries.length) identityQueries.push(supabase.from("customer_identity").select("id, phone_hash, customer_name, normalized_address, wilaya, commune, updated_at").order("updated_at", { ascending: false }).limit(12));

    const identityResults = await Promise.all(identityQueries);
    const identityMap = new Map<string, IdentityRow>();
    for (const result of identityResults) for (const row of (result.data ?? []) as IdentityRow[]) identityMap.set(row.id, row);
    const identities = Array.from(identityMap.values());
    const identityIds = identities.map((r) => r.id);

    const [reputationResult, ordersResult, merchantsResult] = await Promise.all([
      identityIds.length
        ? supabase.from("customer_reputation").select("identity_id, total_orders, delivered_orders, returned_orders, refused_orders, cancelled_orders, merchant_count, reputation_score, risk_level, updated_at").in("identity_id", identityIds)
        : Promise.resolve({ data: [] as ReputationRow[], error: null }),
      identityIds.length
        ? supabase.from("delivery_orders").select("identity_id, merchant_id, provider, status, order_amount, synced_at").in("identity_id", identityIds).order("synced_at", { ascending: false }).limit(1000)
        : Promise.resolve({ data: [] as OrderRow[], error: null }),
      identityIds.length
        ? supabase.from("merchants").select("id, name")
        : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
    ]);

    const reputationByIdentity = new Map(((reputationResult.data ?? []) as ReputationRow[]).map((r) => [r.identity_id, r]));
    const merchantNameById = new Map(((merchantsResult.data ?? []) as { id: string; name: string }[]).map((r) => [r.id, r.name]));
    const orderRows = (ordersResult.data ?? []) as OrderRow[];
    const ordersByIdentity = new Map<string, OrderRow[]>();
    for (const row of orderRows) {
      if (!row.identity_id) continue;
      const list = ordersByIdentity.get(row.identity_id) ?? [];
      list.push(row);
      ordersByIdentity.set(row.identity_id, list);
    }

    searchResults = identities.map((identity) => {
      const reputation = reputationByIdentity.get(identity.id) ?? null;
      const orders = ordersByIdentity.get(identity.id) ?? [];
      const merchantHistory = new Map<string, { merchantName: string; total: number; failed: number; returned: number; refused: number; lastSeen: string }>();
      let failedDeliveries = 0;
      let networkDamage = 0;
      for (const order of orders) {
        const mid = order.merchant_id ?? "unknown";
        const cur = merchantHistory.get(mid) ?? { merchantName: merchantNameById.get(mid) ?? "Unknown merchant", total: 0, failed: 0, returned: 0, refused: 0, lastSeen: order.synced_at };
        cur.total += 1;
        cur.lastSeen = cur.lastSeen > order.synced_at ? cur.lastSeen : order.synced_at;
        if (["RETURNED", "REFUSED", "CANCELLED"].includes(order.status)) { cur.failed += 1; failedDeliveries += 1; networkDamage += Number(order.order_amount ?? 0); }
        if (order.status === "RETURNED") cur.returned += 1;
        if (order.status === "REFUSED") cur.refused += 1;
        merchantHistory.set(mid, cur);
      }
      return {
        identity,
        reputation,
        merchantHistoryRows: Array.from(merchantHistory.values()).sort((a, b) => b.total - a.total).slice(0, 4),
        recentOrders: orders.slice(0, 6).map((o) => ({
          title: `${o.provider} · ${o.status.toLowerCase()}`,
          subtitle: new Date(o.synced_at).toLocaleString(),
          meta: `${Math.round(Number(o.order_amount ?? 0)).toLocaleString()} DZD`,
          tone: ["RETURNED", "REFUSED", "CANCELLED"].includes(o.status) ? "rose" as const : "emerald" as const,
        })),
        failedDeliveries,
        networkDamage,
      };
    });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <AdminBadge tone="sky">Network Intelligence</AdminBadge>
        <h1 className="text-3xl font-semibold tracking-tight text-white">Identity network control room</h1>
        <p className="max-w-3xl text-sm text-slate-300">Customer reputation, identity fingerprints, merchant network map, and fraud graph.</p>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        <AdminMetricCard label="Connected Stores"   value={overview.connectedStores}           tone="sky" />
        <AdminMetricCard label="Delivery Accounts"  value={overview.connectedDeliveryAccounts} tone="emerald" />
        <AdminMetricCard label="Total Orders"       value={overview.totalOrders}               tone="gold" sparkline={trend} />
        <AdminMetricCard label="Tracked Customers"  value={overview.trackedCustomers}          tone="amber" />
        <AdminMetricCard label="Fingerprints"       value={overview.identityFingerprints}      tone="violet" />
        <AdminMetricCard label="High Risk"          value={overview.highRiskCustomers}         tone="rose" />
      </section>

      <div className="flex gap-1 rounded-2xl border border-slate-700/40 bg-slate-800/30 p-1">
        {TABS.map(({ key, label }) => (
          <a
            key={key}
            href={`/admin/network?tab=${key}`}
            className={`flex-1 rounded-xl px-4 py-2 text-center text-sm font-medium transition-colors ${
              tab === key ? "bg-slate-700/60 text-white" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            {label}
          </a>
        ))}
      </div>

      {/* ── Customer Reputation ───────────────────────────────────────────── */}
      {tab === "reputation" && (
        <div className="space-y-6">
          <AdminPanel>
            <form className="grid gap-3 lg:grid-cols-[1.1fr_1fr_1fr_auto]" method="GET">
              <input type="hidden" name="tab" value="reputation" />
              <input name="phone" defaultValue={searchParams?.phone ?? ""} placeholder="Phone" className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-500" />
              <input name="name" defaultValue={searchParams?.name ?? ""} placeholder="Customer name" className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-500" />
              <input name="address" defaultValue={searchParams?.address ?? ""} placeholder="Address / wilaya" className="rounded-xl border border-slate-700/40 bg-slate-800/40 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-500" />
              <button type="submit" className="rounded-2xl bg-[#D6A74C] px-5 py-3 text-sm font-semibold text-[#08111A] transition hover:brightness-110">Search</button>
            </form>
          </AdminPanel>

          {hasSearch && (
            <div className="space-y-4">
              {searchResults.map((result) => {
                const rep = result.reputation;
                const total = Number(rep?.total_orders ?? 0);
                const score = Number(rep?.reputation_score ?? 50);
                const risk = String(rep?.risk_level ?? "MEDIUM");
                const returnRate = total > 0 ? Number((((Number(rep?.returned_orders ?? 0)) / total) * 100).toFixed(1)) : 0;
                const damage = result.networkDamage || Number(rep?.returned_orders ?? 0) * 1500;
                return (
                  <AdminPanel key={result.identity.id} className="space-y-5">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Identity</p>
                        <h2 className="mt-2 text-2xl font-semibold text-white">{result.identity.customer_name ?? "Unknown customer"}</h2>
                        <p className="mt-1 text-sm text-slate-400">{result.identity.normalized_address ?? result.identity.wilaya ?? "No address on record"}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <AdminBadge tone={score >= 75 ? "emerald" : score >= 50 ? "amber" : "rose"}>Global score {score}</AdminBadge>
                        <AdminBadge tone={risk === "LOW" ? "emerald" : risk === "MEDIUM" ? "amber" : "rose"}>{risk} risk</AdminBadge>
                        <AdminBadge tone="sky">{result.identity.wilaya ?? "Unknown wilaya"}</AdminBadge>
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-5">
                      {[
                        { label: "Failed Deliveries",  value: result.failedDeliveries.toLocaleString() },
                        { label: "Refused Orders",     value: Number(rep?.refused_orders ?? 0).toLocaleString() },
                        { label: "Returned Orders",    value: Number(rep?.returned_orders ?? 0).toLocaleString() },
                        { label: "Network Damage",     value: `${Math.round(damage).toLocaleString()} DZD` },
                        { label: "Return Rate",        value: `${returnRate}%` },
                      ].map(({ label, value }) => (
                        <div key={label} className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4">
                          <p className="text-[11px] uppercase tracking-[0.18em] text-slate-400">{label}</p>
                          <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
                        </div>
                      ))}
                    </div>
                    <div className="grid gap-4 xl:grid-cols-2">
                      <AdminPanel className="border-white/10 bg-white/6 text-slate-50">
                        <AdminSectionHeader eyebrow="Merchant history" title="Cross-merchant footprint" description="Recent merchants where this identity appeared." />
                        <div className="mt-4"><FlowList emptyLabel="No merchant history found." items={result.merchantHistoryRows.map((row) => ({ title: row.merchantName, subtitle: `${row.total} orders · ${row.failed} failed · last seen ${new Date(row.lastSeen).toLocaleDateString()}`, meta: `${row.returned + row.refused} critical` }))} /></div>
                      </AdminPanel>
                      <AdminPanel className="border-white/10 bg-white/6 text-slate-50">
                        <AdminSectionHeader eyebrow="Recent activity" title="Investigation trail" description="Latest delivery events for this identity." />
                        <div className="mt-4"><FlowList emptyLabel="No activity available." items={result.recentOrders} /></div>
                      </AdminPanel>
                    </div>
                  </AdminPanel>
                );
              })}
              {searchResults.length === 0 && (
                <AdminPanel>
                  <p className="text-sm text-slate-300">No identities matched this search. Try another phone, name, or address fragment.</p>
                </AdminPanel>
              )}
            </div>
          )}

          {!hasSearch && (
            <AdminPanel className="space-y-4">
              <AdminSectionHeader eyebrow="Intel feed" title="Top threat signals" description="Customers ranked by risk score across the network." />
              <FlowList
                emptyLabel="No network threats found."
                items={topRiskCustomers.slice(0, 10).map((c) => ({
                  title: c.customerName ?? c.identityId?.slice(0, 10) ?? "—",
                  subtitle: `${c.totalOrders} orders · ${c.refusedOrders} refused · ${c.deliverySuccessRate}% success · ${c.merchantCount} merchants`,
                  meta: `${Math.round(c.estimatedDamageDzd).toLocaleString()} DZD`,
                  tone: c.riskLevel === "BLACKLIST" ? "rose" : c.riskLevel === "HIGH_RISK" ? "amber" : "sky",
                }))}
              />
            </AdminPanel>
          )}
        </div>
      )}

      {/* ── Identity Fingerprints ─────────────────────────────────────────── */}
      {tab === "fingerprints" && (
        <AdminPanel className="space-y-4">
          <AdminSectionHeader
            eyebrow="Identity linkage"
            title="Fingerprint index"
            description={`${fingerprints.length} fingerprints indexed across the merchant network.`}
          />
          {fingerprints.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500">No fingerprints indexed yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-700/40">
              <table className="min-w-full text-sm">
                <thead className="border-b border-slate-700/40 bg-slate-800/40">
                  <tr>
                    {["Fingerprint", "Confidence", "Linked identities", "Created"].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/30">
                  {fingerprints.map((fp) => (
                    <tr key={fp.id} className="transition hover:bg-slate-800/30">
                      <td className="px-4 py-3 font-mono text-xs text-slate-400">{fp.fingerprint_hash?.slice(0, 20) ?? "—"}…</td>
                      <td className="px-4 py-3 text-slate-300">{Number(fp.confidence_score).toFixed(2)}%</td>
                      <td className="px-4 py-3 text-slate-300">{(fp.identity_links as Array<{ count: number }>)?.[0]?.count ?? 0}</td>
                      <td className="px-4 py-3 text-slate-500">{new Date(fp.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AdminPanel>
      )}

      {/* ── Merchant Network ──────────────────────────────────────────────── */}
      {tab === "merchant" && (
        <div className="space-y-6">
          <section className="grid gap-4 xl:grid-cols-3">
            <AdminPanel className="xl:col-span-2 space-y-4">
              <AdminSectionHeader eyebrow="Network map" title="Connections between identities" description="Clusters of shared fingerprints and high-risk customers." />
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-3xl border border-slate-700/40 bg-slate-800/40 p-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Identity network graph</p>
                  <svg viewBox="0 0 420 260" className="mt-4 h-64 w-full rounded-2xl bg-[#07111B] p-3">
                    <defs>
                      <linearGradient id="networkGlow" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#D6A74C" stopOpacity="0.9" />
                        <stop offset="100%" stopColor="#34D399" stopOpacity="0.7" />
                      </linearGradient>
                    </defs>
                    {topRiskCustomers.slice(0, 5).map((customer, index) => {
                      const angle = (index / 5) * Math.PI * 2;
                      const x = 210 + Math.cos(angle) * 85;
                      const y = 130 + Math.sin(angle) * 70;
                      return (
                        <g key={customer.identityId}>
                          <line x1="210" y1="130" x2={x} y2={y} stroke="rgba(255,255,255,0.14)" strokeWidth="1.5" />
                          <circle cx={x} cy={y} r="14" fill="url(#networkGlow)" opacity="0.9" />
                          <circle cx={x} cy={y} r="20" fill="none" stroke="rgba(255,255,255,0.16)" />
                        </g>
                      );
                    })}
                    <circle cx="210" cy="130" r="26" fill="#0F1B2A" stroke="#D6A74C" strokeWidth="2" />
                    <circle cx="210" cy="130" r="40" fill="none" stroke="rgba(214,167,76,0.18)" strokeWidth="2" />
                  </svg>
                </div>
                <div className="rounded-3xl border border-slate-700/40 bg-slate-800/40 p-5">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Top threat signals</p>
                  <div className="mt-4">
                    <FlowList
                      emptyLabel="No clusters available."
                      items={topRiskCustomers.slice(0, 6).map((c) => ({
                        title: c.customerName ?? c.identityId?.slice(0, 10) ?? "—",
                        subtitle: `${c.totalOrders} orders · ${c.refusedOrders} refused`,
                        meta: `${Math.round(c.estimatedDamageDzd).toLocaleString()} DZD`,
                        tone: c.riskLevel === "BLACKLIST" ? "rose" : c.riskLevel === "HIGH_RISK" ? "amber" : "sky",
                      }))}
                    />
                  </div>
                </div>
              </div>
            </AdminPanel>

            <AdminPanel className="space-y-4">
              <AdminSectionHeader eyebrow="Hot zones" title="Top risk wilayas" description="Wilayas with the highest average risk scores." />
              <div className="overflow-hidden rounded-xl border border-slate-700/40">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-800/60 text-left text-xs uppercase border-b border-slate-700/40 tracking-[0.2em] text-slate-400">
                    <tr>
                      <th className="px-4 py-3">Wilaya</th>
                      <th className="px-4 py-3">Orders</th>
                      <th className="px-4 py-3">Avg risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topWilayaRankings.map((row) => (
                      <tr key={row.wilaya} className="border-t border-slate-700/30">
                        <td className="px-4 py-3 text-slate-200">{row.wilaya}</td>
                        <td className="px-4 py-3 text-slate-300">{row.orders}</td>
                        <td className="px-4 py-3 text-slate-300">{row.return_rate.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </AdminPanel>
          </section>

          <AdminPanel className="space-y-4">
            <AdminSectionHeader eyebrow="Transport layer" title="Phones and addresses under pressure" description="High-risk contact points with repeated negative outcomes." />
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Top risk phones</p>
                <FlowList emptyLabel="No phone risk found." items={topRiskPhones.slice(0, 5).map((row) => ({ title: row.phoneHash?.slice(0, 12) ?? "—", subtitle: `${row.problematicOrders}/${row.totalOrders} problematic orders`, meta: `${Math.round(row.riskRatio * 100)}% risk`, tone: "rose" as const }))} />
              </div>
              <div className="rounded-xl border border-slate-700/40 bg-slate-800/40 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">Top risk addresses</p>
                <FlowList emptyLabel="No address risk found." items={topRiskAddresses.slice(0, 5).map((row) => ({ title: row.address?.slice(0, 24) ?? "—", subtitle: `${row.problematicOrders}/${row.totalOrders} problematic orders`, meta: `${Math.round(row.riskRatio * 100)}% risk`, tone: "amber" as const }))} />
              </div>
            </div>
          </AdminPanel>
        </div>
      )}

      {/* ── Fraud Graph ───────────────────────────────────────────────────── */}
      {tab === "fraud" && (
        <AdminPanel className="space-y-4">
          <AdminSectionHeader
            eyebrow="Coming soon"
            title="Fraud Graph"
            description="Visual graph of connected fraud actors, shared device fingerprints, and cross-merchant fraud rings."
          />
          <div className="grid gap-4 lg:grid-cols-2">
            {[
              { title: "Fraud Rings", description: "Clusters of identities sharing fingerprints, phones, and addresses who coordinate refusals." },
              { title: "Device Fingerprint Graph", description: "Link identities through shared device signals — browser, screen, timezone, and IP patterns." },
              { title: "Cross-Merchant Fraud", description: "Identify customers who switched merchants after being blocked, targeting new stores." },
              { title: "Fraud Score Decay", description: "Track how customer risk scores evolve after extended clean delivery history." },
            ].map((item) => (
              <div key={item.title} className="rounded-xl border border-slate-700/30 bg-slate-800/30 p-5">
                <p className="text-sm font-semibold text-slate-200">{item.title}</p>
                <p className="mt-1 text-xs text-slate-500">{item.description}</p>
                <p className="mt-3 text-xs font-semibold uppercase tracking-[0.15em] text-slate-600">Not yet available</p>
              </div>
            ))}
          </div>
        </AdminPanel>
      )}
    </div>
  );
}
