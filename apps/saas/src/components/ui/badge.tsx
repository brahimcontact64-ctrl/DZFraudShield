import { cn } from "@/lib/utils";

const variants = {
  LOW: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  MEDIUM: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  HIGH: "bg-orange-50 text-orange-800 ring-1 ring-orange-200",
  CRITICAL: "bg-rose-50 text-rose-800 ring-1 ring-rose-300",
  BLOCK: "bg-rose-100 text-rose-900 ring-1 ring-rose-400"
} as const;

export function RiskBadge({ level }: { level: keyof typeof variants | string }) {
  const key = level as keyof typeof variants;
  const style = variants[key] ?? "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  return <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold", style)}>{level}</span>;
}

const merchantStatusStyles = {
  CLEAN: { dot: "bg-emerald-500", badge: "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200", label: "Clean" },
  WATCHLIST: { dot: "bg-amber-400", badge: "bg-amber-50 text-amber-800 ring-1 ring-amber-200", label: "Watchlist" },
  RISKY: { dot: "bg-orange-500", badge: "bg-orange-50 text-orange-800 ring-1 ring-orange-200", label: "Risky" },
  BLACKLISTED: { dot: "bg-rose-600", badge: "bg-rose-50 text-rose-900 ring-1 ring-rose-300", label: "Blacklisted" },
} as const;

export type MerchantRiskStatus = keyof typeof merchantStatusStyles;

export function MerchantRiskBadge({ status, showDot = true }: { status: MerchantRiskStatus; showDot?: boolean }) {
  const s = merchantStatusStyles[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold", s.badge)}>
      {showDot && <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />}
      {s.label}
    </span>
  );
}
