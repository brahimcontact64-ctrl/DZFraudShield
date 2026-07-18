import { cn } from "@/lib/utils";

type AdminPanelProps = React.HTMLAttributes<HTMLDivElement>;

export function AdminPanel({ className, ...props }: AdminPanelProps) {
  return (
    <div
      className={cn("rounded-2xl border border-slate-700/50 bg-[#0F1C2E] p-5", className)}
      {...props}
    />
  );
}

export function AdminSectionHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        {eyebrow ? (
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
            {eyebrow}
          </p>
        ) : null}
        <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
        {description ? (
          <p className="max-w-2xl text-sm text-slate-400">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function AdminMetricCard({
  label,
  value,
  delta,
  caption,
  sparkline,
  tone = "gold",
}: {
  label: string;
  value: string | number;
  delta?: string;
  caption?: string;
  sparkline?: number[];
  tone?: "gold" | "emerald" | "amber" | "rose" | "sky" | "violet";
}) {
  const accentBar = {
    gold: "bg-[#D6A74C]",
    emerald: "bg-emerald-500",
    amber: "bg-amber-500",
    rose: "bg-rose-500",
    sky: "bg-sky-500",
    violet: "bg-violet-500",
  }[tone];

  const valueColor = {
    gold: "text-[#F7DEAB]",
    emerald: "text-emerald-300",
    amber: "text-amber-300",
    rose: "text-rose-300",
    sky: "text-sky-300",
    violet: "text-violet-300",
  }[tone];

  const sparkColor = {
    gold: "text-[#D6A74C]",
    emerald: "text-emerald-400",
    amber: "text-amber-400",
    rose: "text-rose-400",
    sky: "text-sky-400",
    violet: "text-violet-400",
  }[tone];

  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-700/50 bg-[#0F1C2E] p-5">
      <span
        className={cn("absolute inset-y-0 start-0 w-[3px] rounded-s-2xl", accentBar)}
        aria-hidden="true"
      />
      <div className="flex items-start justify-between gap-4 ps-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
            {label}
          </p>
          <p className={cn("mt-2 text-2xl font-bold tracking-tight", valueColor)}>{value}</p>
          {delta ? <p className="mt-1 text-xs text-slate-400">{delta}</p> : null}
          {caption ? <p className="mt-0.5 text-[11px] text-slate-500">{caption}</p> : null}
        </div>
        {sparkline ? (
          <div className={cn("h-12 w-20 shrink-0", sparkColor)}>
            <Sparkline values={sparkline} className="h-full w-full" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function AdminBadge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "emerald" | "amber" | "rose" | "sky" | "violet";
}) {
  const cls = {
    neutral: "bg-slate-700/50 text-slate-300 ring-slate-600/40",
    emerald: "bg-emerald-900/40 text-emerald-300 ring-emerald-700/30",
    amber: "bg-amber-900/40 text-amber-300 ring-amber-700/30",
    rose: "bg-rose-900/40 text-rose-300 ring-rose-700/30",
    sky: "bg-sky-900/40 text-sky-300 ring-sky-700/30",
    violet: "bg-violet-900/40 text-violet-300 ring-violet-700/30",
  }[tone];

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1",
        cls
      )}
    >
      {children}
    </span>
  );
}

export function Sparkline({
  values,
  className,
}: {
  values: number[];
  className?: string;
}) {
  const points = values.length > 0 ? values : [0];
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = Math.max(max - min, 1);
  const width = 100;
  const height = 32;

  const toPoint = (value: number, index: number) => {
    const x =
      points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
    const y = height - ((value - min) / span) * height;
    return `${x},${y}`;
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn("overflow-visible", className)}
      preserveAspectRatio="none"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points.map(toPoint).join(" ")}
      />
    </svg>
  );
}

export function FlowList({
  items,
  emptyLabel,
}: {
  items: Array<{
    title: string;
    subtitle?: string;
    meta?: string;
    tone?: "neutral" | "emerald" | "amber" | "rose" | "sky";
  }>;
  emptyLabel: string;
}) {
  if (!items.length) {
    return (
      <div className="rounded-xl border border-slate-700/40 bg-slate-800/30 px-4 py-10 text-center">
        <p className="text-sm text-slate-500">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li
          key={`${item.title}-${item.meta ?? item.subtitle ?? ""}`}
          className="rounded-xl border border-slate-700/40 bg-slate-800/30 p-3.5 transition hover:border-slate-600/50"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-200">{item.title}</p>
              {item.subtitle ? (
                <p className="mt-0.5 text-xs text-slate-500">{item.subtitle}</p>
              ) : null}
            </div>
            {item.meta ? (
              <AdminBadge tone={item.tone ?? "neutral"}>{item.meta}</AdminBadge>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
