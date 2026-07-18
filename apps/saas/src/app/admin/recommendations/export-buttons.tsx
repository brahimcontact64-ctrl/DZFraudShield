"use client";

import type { Recommendation } from "@/lib/recommendation-engine/types";

type ExportButtonsProps = {
  recommendations: Recommendation[];
};

function toCSV(recs: Recommendation[]): string {
  const headers = [
    "ID",
    "Merchant ID",
    "Merchant Name",
    "Category",
    "Type",
    "Priority",
    "Title",
    "Description",
    "Reason",
    "Business Impact",
    "Estimated Savings (DZD)",
    "Estimated Revenue Increase (DZD)",
    "Confidence Score",
    "Generated At",
    "Product Name",
    "Wilaya",
    "Provider",
    "Category Name",
  ];

  const escape = (v: string | number | undefined | null): string => {
    const s = String(v ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const rows = recs.map((r) =>
    [
      r.id,
      r.merchantId ?? "",
      r.merchantName ?? "",
      r.category,
      r.type,
      r.priority,
      r.title,
      r.description,
      r.reason,
      r.businessImpact,
      r.estimatedSavingsDzd,
      r.estimatedRevenueIncreaseDzd,
      r.confidenceScore,
      r.generatedAt,
      r.productName ?? "",
      r.wilaya ?? "",
      r.provider ?? "",
      r.categoryName ?? "",
    ]
      .map(escape)
      .join(","),
  );

  return [headers.map(escape).join(","), ...rows].join("\n");
}

function download(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ExportButtons({ recommendations }: ExportButtonsProps) {
  const ts = new Date().toISOString().slice(0, 10);

  function handleExportJSON() {
    download(
      JSON.stringify(recommendations, null, 2),
      `recommendations-${ts}.json`,
      "application/json",
    );
  }

  function handleExportCSV() {
    download(toCSV(recommendations), `recommendations-${ts}.csv`, "text/csv");
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleExportJSON}
        className="rounded-lg border border-slate-700/50 bg-slate-800/50 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-700/50"
      >
        Export JSON
      </button>
      <button
        onClick={handleExportCSV}
        className="rounded-lg border border-slate-700/50 bg-slate-800/50 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-700/50"
      >
        Export CSV
      </button>
    </div>
  );
}
