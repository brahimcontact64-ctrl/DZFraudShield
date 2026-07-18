import { cn } from "@/lib/utils";

const statusStyles = {
  connected: "bg-emerald-100 text-emerald-800",
  failed: "bg-rose-100 text-rose-800",
  credentials_invalid: "bg-rose-100 text-rose-800",
  attention_required: "bg-amber-100 text-amber-800",
  syncing: "bg-amber-100 text-amber-800",
  inactive: "bg-slate-100 text-slate-700",
  unknown: "bg-slate-100 text-slate-600"
} as const;

type StatusKind = keyof typeof statusStyles;

export function StatusBadge({ status, label }: { status: StatusKind; label?: string }) {
  return (
    <span className={cn("inline-flex rounded-full px-2.5 py-1 text-xs font-semibold", statusStyles[status])}>
      {label ?? status}
    </span>
  );
}
