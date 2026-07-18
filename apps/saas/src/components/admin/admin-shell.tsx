"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  AlertIcon,
  BellIcon,
  BarChartIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DatabaseIcon,
  KeyIcon,
  LayoutIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  StoreIcon,
  TruckIcon,
  UserIcon,
  ZapIcon,
} from "@/components/ui/icons";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string; size?: number }>;
  exact?: boolean;
  badge?: string;
};

type NavSection = {
  label: string;
  items: NavItem[];
};

const adminSections: NavSection[] = [
  {
    label: "OPERATIONS",
    items: [
      { href: "/admin", label: "Overview", Icon: LayoutIcon, exact: true },
      { href: "/admin/merchants", label: "Merchants", Icon: StoreIcon },
      { href: "/admin/jobs", label: "Background Jobs", Icon: ZapIcon },
    ],
  },
  {
    label: "INTELLIGENCE",
    items: [
      { href: "/admin/network", label: "Network Intelligence", Icon: BarChartIcon, exact: true },
      { href: "/admin/marketing-intelligence", label: "Marketing Intelligence", Icon: DatabaseIcon },
      { href: "/admin/merchant-intelligence", label: "Merchant Intelligence", Icon: StoreIcon },
      { href: "/admin/recommendations", label: "Recommendations", Icon: ZapIcon },
      { href: "/admin/analytics-ai", label: "Predictive Analytics", Icon: BarChartIcon },
      { href: "/admin/automation", label: "Automation Engine", Icon: RefreshIcon },
      { href: "/admin/strategy", label: "Strategy Engine", Icon: ShieldIcon },
    ],
  },
  {
    label: "DELIVERY",
    items: [
      { href: "/admin/delivery-intelligence", label: "Delivery Intelligence", Icon: TruckIcon },
      { href: "/admin/providers", label: "Providers", Icon: KeyIcon },
      { href: "/admin/network/sync", label: "Network Sync", Icon: RefreshIcon },
      { href: "/admin/internal/delivery-cache", label: "Delivery Cache", Icon: DatabaseIcon },
      { href: "/admin/webhooks", label: "Webhooks", Icon: BellIcon },
    ],
  },
  {
    label: "PLATFORM",
    items: [
      { href: "/admin/health", label: "Platform Monitoring", Icon: ShieldIcon },
      { href: "/admin/internal/risk-events", label: "Risk Events", Icon: AlertIcon },
      { href: "/admin/internal/sync-logs", label: "Sync Logs", Icon: RefreshIcon },
      { href: "/admin/audit", label: "Audit Logs", Icon: SearchIcon },
      { href: "/admin/api", label: "API Management", Icon: KeyIcon },
      { href: "/admin/migration-audit", label: "Migration Audit", Icon: ShieldIcon },
    ],
  },
  {
    label: "SETTINGS",
    items: [
      { href: "/admin/settings", label: "Platform Settings", Icon: SettingsIcon },
    ],
  },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();

  function isActive(href: string, exact?: boolean) {
    if (!pathname) return false;
    if (exact) return pathname === href;
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#07111B] text-slate-100">
      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside
        className={cn(
          "relative flex shrink-0 flex-col border-r border-slate-700/40 bg-[#050E1A] transition-[width] duration-200",
          collapsed ? "w-[68px]" : "w-[220px]"
        )}
      >
        {/* Logo */}
        <div
          className={cn(
            "flex h-14 shrink-0 items-center border-b border-slate-700/40",
            collapsed ? "justify-center" : "gap-3 px-4"
          )}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#D6A74C]/10 text-[#D6A74C] ring-1 ring-[#D6A74C]/20">
            <ZapIcon size={15} />
          </div>
          {!collapsed ? (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">DZ Fraud Shield</p>
              <p className="text-[10px] uppercase tracking-widest text-slate-500">Admin</p>
            </div>
          ) : null}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-3 scrollbar-thin">
          {adminSections.map((section, sectionIdx) => (
            <div key={section.label} className={sectionIdx > 0 ? "mt-4" : ""}>
              {!collapsed ? (
                <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-600">
                  {section.label}
                </p>
              ) : sectionIdx > 0 ? (
                <div className="mx-3 my-2 h-px bg-slate-700/40" />
              ) : null}
              <div className="space-y-0.5">
                {section.items.map(({ href, label, Icon, exact, badge }) => {
                  const active = isActive(href, exact);
                  return (
                    <Link
                      key={href}
                      href={href as any}
                      title={collapsed ? label : undefined}
                      className={cn(
                        "group relative flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                        active
                          ? "bg-slate-700/40 text-white"
                          : "text-slate-400 hover:bg-slate-700/20 hover:text-slate-200"
                      )}
                    >
                      {active ? (
                        <span
                          className="absolute inset-y-2 start-0 w-0.5 rounded-e-full bg-[#D6A74C]"
                          aria-hidden="true"
                        />
                      ) : null}
                      <Icon
                        size={15}
                        className={cn(
                          "shrink-0",
                          active ? "text-[#D6A74C]" : "text-slate-500 group-hover:text-slate-300"
                        )}
                      />
                      {!collapsed ? (
                        <>
                          <span className="flex-1 truncate">{label}</span>
                          {badge ? (
                            <span className="rounded-full bg-slate-700/50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                              {badge}
                            </span>
                          ) : null}
                        </>
                      ) : null}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer */}
        {!collapsed ? (
          <div className="border-t border-slate-700/40 p-2.5">
            <div className="flex items-center gap-2.5 rounded-xl border border-slate-700/30 bg-slate-800/40 px-3 py-2.5">
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#D6A74C]/10 text-[#D6A74C]">
                <UserIcon size={13} />
              </div>
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-slate-200">Admin Console</p>
                <p className="text-[10px] text-slate-500">Operator access</p>
              </div>
            </div>
          </div>
        ) : null}

        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="absolute -end-3 top-[54px] z-10 flex h-6 w-6 items-center justify-center rounded-full border border-slate-700/60 bg-[#050E1A] text-slate-400 shadow-sm transition hover:text-slate-100"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRightIcon size={12} /> : <ChevronLeftIcon size={12} />}
        </button>
      </aside>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-700/40 bg-[#07111B] px-5 md:px-6">
          <div className="hidden items-center md:flex">
            <span className="rounded-full border border-slate-700/40 bg-slate-800/50 px-3 py-1 text-[11px] text-slate-400">
              Algeria-wide fraud intelligence
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-700/40 bg-slate-800/40 text-slate-400 transition hover:text-slate-200"
              aria-label="Notifications"
            >
              <BellIcon size={14} />
            </button>
            <div className="flex h-8 items-center gap-2 rounded-lg border border-slate-700/40 bg-slate-800/40 px-2.5 text-[11px] text-slate-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
              Live
            </div>
          </div>
        </header>

        {/* Main */}
        <main className="flex-1 overflow-y-auto px-4 py-5 md:px-6 md:py-6">
          {children}
        </main>
      </div>
    </div>
  );
}
