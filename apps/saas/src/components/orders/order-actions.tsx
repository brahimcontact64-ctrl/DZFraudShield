"use client";

import { useMemo, useState, useTransition } from "react";
import { useI18n } from "@/lib/i18n/client";

type ActionState = {
  decision: "ACCEPTED" | "VERIFY_FIRST" | "BLOCKED" | null;
  provider: string | null;
  shipmentStatus: string | null;
  trackingNumber: string | null;
  labelPdfUrl: string | null;
  labelsUrl: string | null;
  labelUrl: string | null;
  message: string | null;
};

type ShippingOriginChoice = {
  id: string;
  name: string;
  is_default: boolean;
};

export function OrderActions(props: {
  checkId: string;
  phone: string | null;
  viewDetailsHref?: string;
  initialDecision?: "ACCEPTED" | "VERIFY_FIRST" | "BLOCKED" | null;
  initialProvider?: string | null;
  initialShipmentStatus?: string | null;
  initialTrackingNumber?: string | null;
  initialLabelPdfUrl?: string | null;
  initialLabelsUrl?: string | null;
  initialLabelUrl?: string | null;
  compact?: boolean;
  showSecondaryActions?: boolean;
}) {
  const { t } = useI18n();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<ActionState>({
    decision: props.initialDecision ?? null,
    provider: props.initialProvider ?? null,
    shipmentStatus: props.initialShipmentStatus ?? null,
    trackingNumber: props.initialTrackingNumber ?? null,
    labelPdfUrl: props.initialLabelPdfUrl ?? null,
    labelsUrl: props.initialLabelsUrl ?? null,
    labelUrl: props.initialLabelUrl ?? null,
    message: null
  });
  const [originChoices, setOriginChoices] = useState<ShippingOriginChoice[]>([]);
  const [selectedOriginId, setSelectedOriginId] = useState<string>("");
  const [requiresOriginSelection, setRequiresOriginSelection] = useState(false);

  async function loadOriginChoices(): Promise<ShippingOriginChoice[]> {
    const response = await fetch("/api/v1/delivery/yalidine/shipping-origins", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return [];
    }

    const origins = Array.isArray(payload?.origins) ? payload.origins : [];
    const mapped = origins
      .map((origin: unknown) => {
        const row = origin as Record<string, unknown>;
        const id = typeof row.id === "string" ? row.id : "";
        const name = typeof row.name === "string" ? row.name : "";
        if (!id || !name) {
          return null;
        }
        return {
          id,
          name,
          is_default: Boolean(row.is_default),
        };
      })
      .filter((item: ShippingOriginChoice | null): item is ShippingOriginChoice => Boolean(item));

    return mapped;
  }

  const whatsappUrl = useMemo(() => {
    const phone = props.phone;
    if (!phone) return null;
    const digits = phone.replace(/\D/g, "");
    if (!digits) return null;
    if (digits.startsWith("213")) return `https://wa.me/${digits}`;
    if (digits.startsWith("0")) return `https://wa.me/213${digits.slice(1)}`;
    return `https://wa.me/${digits}`;
  }, [props.phone]);

  const trackingUrl = useMemo(() => {
    if (!state.trackingNumber) return null;
    const query = encodeURIComponent(`${state.provider ?? "shipment"} ${state.trackingNumber}`);
    return `https://www.google.com/search?q=${query}`;
  }, [state.provider, state.trackingNumber]);

  async function runAction(
    action: "confirm" | "verify" | "refuse" | "call_later" | "no_answer" | "create_shipment",
    options?: { shippingOriginId?: string | null }
  ) {
    startTransition(async () => {
      const response = await fetch(`/api/v1/orders/${props.checkId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          shippingOriginId: options?.shippingOriginId ?? null,
        })
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (payload?.error === "shipping_origin_required") {
          const provided = Array.isArray(payload?.origins)
            ? (payload.origins as Array<Record<string, unknown>>)
                .map((origin) => {
                  const id = typeof origin.id === "string" ? origin.id : "";
                  const name = typeof origin.name === "string" ? origin.name : "";
                  if (!id || !name) {
                    return null;
                  }
                  return {
                    id,
                    name,
                    is_default: Boolean(origin.is_default),
                  };
                })
                .filter((item: ShippingOriginChoice | null): item is ShippingOriginChoice => Boolean(item))
            : [];

          const origins = provided.length > 0 ? provided : await loadOriginChoices();
          const preselected = origins.find((item) => item.is_default)?.id ?? origins[0]?.id ?? "";
          setOriginChoices(origins);
          setSelectedOriginId(preselected);
          setRequiresOriginSelection(true);
          setState((prev) => ({
            ...prev,
            provider: payload?.provider ? String(payload.provider) : prev.provider,
            message: t("orderActions.selectShippingOrigin"),
          }));
          return;
        }

        const message = payload?.error === "shipping_profile_missing"
          ? t("orderActions.completeShippingProfile")
          : String(payload?.error ?? t("orderActions.actionFailed"));
        setState((prev) => ({ ...prev, message }));
        return;
      }

      if (action === "confirm") {
        setState((prev) => ({ ...prev, decision: "ACCEPTED", message: String(payload?.message ?? t("orderActions.orderConfirmed")) }));
        return;
      }

      if (action === "verify") {
        setState((prev) => ({ ...prev, decision: "VERIFY_FIRST", message: String(payload?.message ?? t("orderActions.markedVerification")) }));
        return;
      }

      if (action === "refuse") {
        setState((prev) => ({ ...prev, decision: "BLOCKED", message: String(payload?.message ?? t("orderActions.orderRefused")) }));
        return;
      }

      if (action === "create_shipment") {
        setRequiresOriginSelection(false);
        setState((prev) => ({
          ...prev,
          provider: payload?.provider ? String(payload.provider) : prev.provider,
          shipmentStatus: String(payload?.shipmentStatus ?? "CREATED"),
          trackingNumber: payload?.trackingNumber ? String(payload.trackingNumber) : prev.trackingNumber,
          labelPdfUrl: payload?.labelPdfUrl ? String(payload.labelPdfUrl) : prev.labelPdfUrl,
          labelsUrl: payload?.labelsUrl ? String(payload.labelsUrl) : prev.labelsUrl,
          labelUrl: payload?.labelUrl ? String(payload.labelUrl) : prev.labelUrl,
          message: String(payload?.message ?? t("orderActions.shipmentCreated"))
        }));
        return;
      }

      setState((prev) => ({ ...prev, message: String(payload?.message ?? t("orderActions.actionSaved")) }));
    });
  }

  const btn = "rounded-lg border px-3 py-2 text-xs font-semibold transition";
  const compactClass = props.compact ? "text-[11px] px-2.5 py-1.5" : "";
  const hasShipment = Boolean(state.shipmentStatus || state.trackingNumber || state.labelUrl || state.labelPdfUrl || state.labelsUrl);
  const canCreateShipment = state.decision === "ACCEPTED";

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-2">
        {props.phone ? <a href={`tel:${props.phone}`} className={`${btn} ${compactClass} border-slate-200 bg-white text-slate-700 hover:bg-slate-50`}>{t("orderActions.call")}</a> : null}
        {whatsappUrl ? <a href={whatsappUrl} target="_blank" rel="noreferrer" className={`${btn} ${compactClass} border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100`}>{t("orderActions.whatsapp")}</a> : null}
        <button disabled={isPending} onClick={() => runAction("confirm")} className={`${btn} ${compactClass} border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-60`}>{t("orderActions.confirm")}</button>
        <button disabled={isPending} onClick={() => runAction("verify")} className={`${btn} ${compactClass} border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-60`}>{t("orderActions.verify")}</button>
        <button disabled={isPending} onClick={() => runAction("refuse")} className={`${btn} ${compactClass} border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 disabled:opacity-60`}>{t("orderActions.refuse")}</button>
        {props.viewDetailsHref ? <a href={props.viewDetailsHref} className={`${btn} ${compactClass} border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100`}>{t("orderActions.viewDetails")}</a> : null}
      </div>

      {canCreateShipment ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-emerald-700">{t("orderActions.orderConfirmed")}</span>
            <button
              disabled={isPending}
              onClick={() => runAction("create_shipment", { shippingOriginId: selectedOriginId || null })}
              className={`${btn} ${compactClass} border-slate-900 bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-60`}
            >
              {t("orderActions.createShipment")}
            </button>
          </div>
          {requiresOriginSelection ? (
            <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2.5">
              <p className="text-xs font-semibold text-amber-900">{t("orderActions.selectShippingOrigin")}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  className="min-w-[220px] rounded-md border border-amber-300 bg-white px-2.5 py-1.5 text-xs text-slate-700"
                  value={selectedOriginId}
                  onChange={(event) => setSelectedOriginId(event.target.value)}
                  disabled={isPending}
                >
                  {originChoices.map((origin) => (
                    <option key={origin.id} value={origin.id}>
                      {origin.name}{origin.is_default ? " (default)" : ""}
                    </option>
                  ))}
                </select>
                <button
                  disabled={isPending || !selectedOriginId}
                  onClick={() => runAction("create_shipment", { shippingOriginId: selectedOriginId })}
                  className={`${btn} ${compactClass} border-amber-700 bg-amber-700 text-white hover:bg-amber-600 disabled:opacity-60`}
                >
                  {t("orderActions.createShipment")}
                </button>
              </div>
            </div>
          ) : null}
          {state.provider ? <p className="mt-2 text-xs text-emerald-900">{t("orderActions.provider")}: <span className="font-semibold">{state.provider.replace(/_/g, " ")}</span></p> : null}
          {state.trackingNumber ? <p className="mt-1 text-xs text-emerald-900">{t("orderActions.trackingNumber")}: <span className="font-semibold">{state.trackingNumber}</span></p> : null}
          {state.shipmentStatus ? <p className="mt-1 text-xs text-emerald-900">{t("orderActions.shipmentStatus")}: <span className="font-semibold">{state.shipmentStatus.replace(/_/g, " ")}</span></p> : null}
          {state.shipmentStatus && !(state.labelPdfUrl || state.labelsUrl || state.labelUrl) ? <p className="mt-1 text-xs font-semibold text-emerald-900">{t("orderActions.labelPending")}</p> : null}
        </div>
      ) : null}

      {hasShipment ? (
        <div className="flex flex-wrap gap-2">
          {(state.labelPdfUrl ?? state.labelUrl) ? (
            <a href={state.labelPdfUrl ?? state.labelUrl ?? "#"} target="_blank" rel="noreferrer" className={`${btn} ${compactClass} border-slate-200 bg-white text-slate-700 hover:bg-slate-50`}>
              {t("orderActions.printLabel")}
            </a>
          ) : null}
          {(state.labelsUrl ?? state.labelUrl) ? (
            <a href={state.labelsUrl ?? state.labelUrl ?? "#"} target="_blank" rel="noreferrer" className={`${btn} ${compactClass} border-slate-200 bg-white text-slate-700 hover:bg-slate-50`}>
              {t("orderActions.downloadLabel")}
            </a>
          ) : null}
          {trackingUrl ? (
            <a href={trackingUrl} target="_blank" rel="noreferrer" className={`${btn} ${compactClass} border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100`}>
              {t("orderActions.trackShipment")}
            </a>
          ) : null}
          {props.phone ? <a href={`tel:${props.phone}`} className={`${btn} ${compactClass} border-slate-200 bg-white text-slate-700 hover:bg-slate-50`}>{t("orderActions.callCustomer")}</a> : null}
          {whatsappUrl ? <a href={whatsappUrl} target="_blank" rel="noreferrer" className={`${btn} ${compactClass} border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100`}>{t("orderActions.whatsappCustomer")}</a> : null}
        </div>
      ) : null}

      {props.showSecondaryActions ? (
        <div className="flex flex-wrap gap-2">
          <button disabled={isPending} onClick={() => runAction("no_answer")} className={`${btn} ${compactClass} border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100 disabled:opacity-60`}>{t("orderActions.noAnswer")}</button>
          <button disabled={isPending} onClick={() => runAction("call_later")} className={`${btn} ${compactClass} border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100 disabled:opacity-60`}>{t("orderActions.callLater")}</button>
        </div>
      ) : null}

      {state.message ? <p className="text-xs text-slate-600">{state.message}</p> : null}
    </div>
  );
}
