"use client";

import { useState, useTransition } from "react";
import { createApiKeyAction } from "./actions";
import { CopyKeyButton } from "./copy-key";
import { useI18n } from "@/lib/i18n/client";

export function ApiKeyGenerator() {
  const { t } = useI18n();
  const [result, setResult] = useState<{ key?: string; error?: string }>({});
  const [isPending, startTransition] = useTransition();

  function onGenerate() {
    startTransition(async () => {
      const res = await createApiKeyAction();
      setResult(res);
    });
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onGenerate}
        disabled={isPending}
        className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isPending ? (
          <>
            <svg className="h-4 w-4 animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {t("dashboard.apiKeys.generating")}
          </>
        ) : (
          <>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t("dashboard.apiKeys.generateButton")}
          </>
        )}
      </button>

      {result.error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {result.error}
        </div>
      )}

      {result.key && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="mb-2 text-xs font-semibold text-emerald-700">{t("dashboard.apiKeys.newKeyHint")}</p>
          <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-white p-3">
            <code className="flex-1 break-all font-mono text-sm text-slate-800">{result.key}</code>
            <CopyKeyButton value={result.key} />
          </div>
        </div>
      )}
    </div>
  );
}
