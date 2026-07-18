import { NextRequest, NextResponse } from "next/server";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { checkOrderSchema } from "@/lib/api/schemas";
import { requireApiKeyAuth } from "@/lib/security/request-auth";
import { createClient } from "@/lib/supabase/server";
import { evaluateUnifiedRisk } from "@/lib/risk/unified-evaluator";
import { buildMerchantFacingDTO } from "@/lib/risk/merchant-facing-dto";
import { allowsNotification, getMerchantNotificationSettings } from "@/lib/notifications/settings";
import { buildNewOrderNotification, buildRiskReviewNotification } from "@/lib/notifications/templates";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { requireActiveApiSubscription } from "@/lib/payments/subscription";

function normalizeIncomingCheckOrderPayload(input: unknown): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }

  const payload = { ...(input as Record<string, unknown>) };

  if (typeof payload.shippingType === "string" && payload.shippingType.trim() === "") {
    delete payload.shippingType;
  }
  if (typeof payload.shippingProvider === "string" && payload.shippingProvider.trim() === "") {
    delete payload.shippingProvider;
  }
  if (typeof payload.shippingWilaya === "string" && payload.shippingWilaya.trim() === "") {
    delete payload.shippingWilaya;
  }
  if (typeof payload.shippingCommune === "string" && payload.shippingCommune.trim() === "") {
    delete payload.shippingCommune;
  }
  if (typeof payload.shippingStopdesk === "string" && payload.shippingStopdesk.trim() === "") {
    delete payload.shippingStopdesk;
  }
  if (typeof payload.shippingOfficeId === "string" && payload.shippingOfficeId.trim() === "") {
    delete payload.shippingOfficeId;
  }

  return payload;
}

export async function POST(req: NextRequest) {
  try {
    const requestStart = performance.now();
    const segmentMs = {
      authApiKeyValidation: 0,
      merchantAccountLookup: 0,
      riskProfileLookup: 0,
      riskHistoryLookup: 0,
      scoring: 0,
      orderCheckInsert: 0,
      notificationEnqueue: 0,
      total: 0,
    };

    const authStarted = performance.now();
    const auth = await requireApiKeyAuth(req, "check-order");
    segmentMs.authApiKeyValidation = performance.now() - authStarted;
    if (!auth.ok) {
      return auth.response;
    }
    const subBlock = await requireActiveApiSubscription(auth.keyRecord.merchant_id);
    if (subBlock) return subBlock;
    const keyRecord = auth.keyRecord;
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

    const supabase = createClient();
    const merchantLookupStarted = performance.now();
    const { count: activeDeliveryAccounts } = await supabase
      .from("merchant_delivery_accounts")
      .select("id", { count: "exact", head: true })
      .eq("merchant_id", keyRecord.merchant_id)
      .eq("active", true);
    segmentMs.merchantAccountLookup = performance.now() - merchantLookupStarted;
    const hasActiveDeliveryAccounts = Boolean(activeDeliveryAccounts && activeDeliveryAccounts > 0);

    const payload = checkOrderSchema.parse(normalizeIncomingCheckOrderPayload(await req.json()));

    if (payload.orderId) {
      const existingCheck = await supabase
        .from("order_checks")
        .select("id, risk_score, risk_level, risk_reasons, recommended_action")
        .eq("merchant_id", keyRecord.merchant_id)
        .eq("order_id", payload.orderId)
        .maybeSingle();

      if (existingCheck.error) {
        throw existingCheck.error;
      }

      if (existingCheck.data) {
        const duplicateResponse = NextResponse.json({
          riskScore: existingCheck.data.risk_score,
          trustLevel: null,
          why: existingCheck.data.risk_reasons ?? [],
          estimatedDamage: null,
          recommendedAction: existingCheck.data.recommended_action ?? "review",
          customerType: "RETURNING",
          localHistory: null,
          score: existingCheck.data.risk_score,
          level: existingCheck.data.risk_level,
          reasons: existingCheck.data.risk_reasons ?? [],
          checkId: existingCheck.data.id,
          duplicate: true,
        });
        duplicateResponse.headers.set("server-timing", `auth;dur=${segmentMs.authApiKeyValidation.toFixed(2)},merchant;dur=${segmentMs.merchantAccountLookup.toFixed(2)},risk_profile;dur=0.00,risk_history;dur=0.00,scoring;dur=0.00,insert;dur=0.00,enqueue;dur=0.00,total;dur=${(performance.now() - requestStart).toFixed(2)}`);
        duplicateResponse.headers.set("x-dz-api-segments", JSON.stringify(segmentMs));
        return duplicateResponse;
      }
    }

    const resolvedPhone = payload.customerPhone ?? payload.phone ?? null;
    const resolvedAddress = payload.customerAddress ?? payload.address ?? null;
    const resolvedTotal = payload.totalAmount ?? payload.cartTotal;
    const resolvedProductItems = payload.productItems ?? [];
    const resolvedProductNames = payload.productNames ?? resolvedProductItems.map((item) => item.productName).filter(Boolean);
    const unified = await evaluateUnifiedRisk({
      merchantId: keyRecord.merchant_id,
      orderId: payload.orderId,
      storeId: payload.storeId,
      phone: payload.phone ?? null,
      customerPhone: payload.customerPhone ?? null,
      customerName: payload.customerName ?? null,
      address: payload.address ?? null,
      customerAddress: payload.customerAddress ?? null,
      city: payload.city ?? null,
      commune: payload.commune ?? null,
      wilaya: payload.wilaya ?? null,
      ip: payload.ip ?? ip,
      userAgent: payload.userAgent ?? null,
      cartTotal: resolvedTotal,
      totalAmount: payload.totalAmount ?? resolvedTotal,
      productCount: payload.productCount,
      paymentMethod: payload.paymentMethod ?? null,
      isCod: payload.isCod,
      productNames: resolvedProductNames,
      productItems: resolvedProductItems
    });
    segmentMs.riskProfileLookup = unified.diagnostics.identityLookupMs + unified.diagnostics.customerProfileLookupMs;
    segmentMs.riskHistoryLookup = unified.diagnostics.merchantHistoryLookupMs + unified.diagnostics.networkHistoryLookupMs + unified.diagnostics.riskEventLookupMs;
    segmentMs.scoring = unified.diagnostics.scoringCalculationMs + unified.diagnostics.recommendationCalculationMs;

    const risk = unified.risk;
    const normalizedPhone = unified.normalizedPhone;
    const phoneHash = unified.phoneHash;
    const ipHash = unified.ipHash;
    const deviceHash = unified.deviceHash;
    const addressHash = payload.addressHash ?? unified.addressHash;
    const identityId = unified.identityId;
    const globalReputation = unified.globalReputation;
    const networkIntelligence = unified.networkIntelligence;
    const identityInsights = unified.identityInsights;
    const clusterInsights = unified.clusterInsights;
    const customerNetworkProfile = unified.customerNetworkProfile;

    const merchantReputation = buildMerchantFacingDTO({
      riskScore: risk.score,
      trustLevel: customerNetworkProfile.networkTrustLevel,
      totalOrders: customerNetworkProfile.totalOrders,
      deliveredOrders: customerNetworkProfile.deliveredOrders,
      refusedOrders: customerNetworkProfile.refusedOrders,
      returnedOrders: customerNetworkProfile.returnedOrders,
      cancelledOrders: customerNetworkProfile.cancelledOrders,
      noAnswerOrders: customerNetworkProfile.noAnswerOrders,
      fakeOrderCount: customerNetworkProfile.fakeOrderCount,
      networkMerchantCount: customerNetworkProfile.merchantCount,
      estimatedDamageDzd: customerNetworkProfile.estimatedDamageDzd,
      deliverySuccessRate: customerNetworkProfile.deliverySuccessRate,
      riskTrend: customerNetworkProfile.riskTrend,
      recentBadEvents: customerNetworkProfile.recentBadEvents,
      recommendedAction: risk.action,
    });

    const localHistory = {
      customerType: customerNetworkProfile.totalOrders > 0 ? "RETURNING" : "NEW",
      totalOrders: customerNetworkProfile.totalOrders,
      deliveredOrders: customerNetworkProfile.deliveredOrders,
      failedOrders: merchantReputation.failedOrders,
      deliverySuccessRate: customerNetworkProfile.deliverySuccessRate,
      summary:
        customerNetworkProfile.totalOrders > 0
          ? `Returning customer with ${customerNetworkProfile.totalOrders} prior network order${customerNetworkProfile.totalOrders > 1 ? "s" : ""}.`
          : "No prior network order history found for this customer."
    };

    const riskLevelForStorage = risk.level === "CRITICAL" ? "BLOCK" : risk.level;

    const baseOrderCheck = {
      merchant_id: keyRecord.merchant_id,
      store_id: keyRecord.store_id ?? payload.storeId ?? null,
      external_order_id: payload.orderId ?? null,
      phone_hash: phoneHash ?? null,
      customer_name: payload.customerName ?? null,
      city: payload.city ?? null,
      wilaya: payload.wilaya ?? null,
      address_hash: addressHash ?? null,
      ip_hash: ipHash,
      device_hash: deviceHash,
      cart_total: resolvedTotal,
      product_count: payload.productCount,
      payment_method: payload.paymentMethod ?? null,
      shipping_provider: payload.shippingProvider ?? null,
      shipping_type: payload.shippingType ?? null,
      shipping_price: payload.shippingPrice ?? null,
      shipping_wilaya: payload.shippingWilaya ?? payload.wilaya ?? null,
      shipping_commune: payload.shippingCommune ?? payload.commune ?? payload.city ?? null,
      shipping_stopdesk: payload.shippingStopdesk ?? null,
      shipping_office_id: payload.shippingOfficeId ?? null,
      is_cod: payload.isCod,
      risk_score: risk.score,
      risk_level: riskLevelForStorage,
      risk_reasons: risk.reasons,
      recommended_action: risk.action
    };

    const extendedOrderCheck = {
      ...baseOrderCheck,
      order_id: payload.orderId ?? null,
      customer_phone: resolvedPhone,
      customer_address: resolvedAddress,
      product_names: resolvedProductNames,
      product_items: resolvedProductItems,
      total_amount: payload.totalAmount ?? resolvedTotal,
      phone_raw: resolvedPhone,
      address: resolvedAddress,
      identity_id: identityId,
      global_reputation_score: globalReputation?.reputationScore ?? null,
      global_total_orders: globalReputation?.totalOrders ?? null,
      global_delivered_orders: globalReputation?.deliveredOrders ?? null,
      global_returned_orders: globalReputation?.returnedOrders ?? null,
      global_refused_orders: globalReputation?.refusedOrders ?? null,
      global_merchant_count: globalReputation?.merchantCount ?? null,
      global_recommendation:
        networkIntelligence.recommendation === "APPROVE"
          ? "Proceed with normal flow"
          : networkIntelligence.recommendation === "REVIEW"
            ? "Call customer before shipping"
            : "High network risk: ship only after strict verification",
      network_risk_score: networkIntelligence.score,
      network_risk_level: networkIntelligence.level,
      network_recommendation: networkIntelligence.recommendation,
      network_reasons: networkIntelligence.reasons
    };

    const insertStarted = performance.now();
    let insertResult = await supabase.from("order_checks").insert(extendedOrderCheck).select("id").single();
    if (insertResult.error) {
      const message = insertResult.error.message.toLowerCase();
      const isDuplicateOrderCheck = insertResult.error.code === "23505" || message.includes("duplicate key value") || message.includes("order_checks_merchant_id_order_id");
      if (isDuplicateOrderCheck && payload.orderId) {
        const duplicateCheck = await supabase
          .from("order_checks").select("id, risk_score, risk_level, risk_reasons, recommended_action")
          .eq("merchant_id", keyRecord.merchant_id)
          .eq("order_id", payload.orderId)
          .maybeSingle();

        if (duplicateCheck.error) {
          throw duplicateCheck.error;
        }

        if (duplicateCheck.data) {
          const duplicateResponse = NextResponse.json({
            riskScore: duplicateCheck.data.risk_score,
            trustLevel: null,
            why: duplicateCheck.data.risk_reasons ?? [],
            estimatedDamage: null,
            recommendedAction: duplicateCheck.data.recommended_action ?? "review",
            customerType: "RETURNING",
            localHistory: null,
            score: duplicateCheck.data.risk_score,
            level: duplicateCheck.data.risk_level,
            reasons: duplicateCheck.data.risk_reasons ?? [],
            checkId: duplicateCheck.data.id,
            duplicate: true,
          });
          duplicateResponse.headers.set("server-timing", `auth;dur=${segmentMs.authApiKeyValidation.toFixed(2)},merchant;dur=${segmentMs.merchantAccountLookup.toFixed(2)},risk_profile;dur=${segmentMs.riskProfileLookup.toFixed(2)},risk_history;dur=${segmentMs.riskHistoryLookup.toFixed(2)},scoring;dur=${segmentMs.scoring.toFixed(2)},insert;dur=${(performance.now() - insertStarted).toFixed(2)},enqueue;dur=0.00,total;dur=${(performance.now() - requestStart).toFixed(2)}`);
          duplicateResponse.headers.set("x-dz-api-segments", JSON.stringify(segmentMs));
          return duplicateResponse;
        }
      }

      if (message.includes("does not exist") || message.includes("column") || message.includes("unknown")) {
        insertResult = await supabase.from("order_checks").insert(baseOrderCheck).select("id").single();
      }
    }
    segmentMs.orderCheckInsert = performance.now() - insertStarted;

    const { data, error } = insertResult;

    if (error) {
      console.error("[DZFS] check-order insert_order_checks_failed", error.message);
      throw error;
    }

    const notificationEnqueueStarted = performance.now();
    void (async () => {
      try {
        const { error: riskEventError } = await supabase.from("risk_events").insert({
          merchant_id: keyRecord.merchant_id,
          order_check_id: data.id,
          event_type: "risk_check_created",
          payload: {
            riskScore: risk.score,
            riskLevel: risk.level,
            reasons: risk.reasons,
            rawPayload: {
              orderId: payload.orderId ?? null,
              phone: resolvedPhone,
              customerPhone: resolvedPhone,
              address: resolvedAddress,
              customerAddress: resolvedAddress,
              customerName: payload.customerName ?? null,
              city: payload.city ?? null,
              wilaya: payload.wilaya ?? null,
              productNames: resolvedProductNames,
              productItems: resolvedProductItems,
              cartTotal: resolvedTotal,
              totalAmount: payload.totalAmount ?? resolvedTotal,
              productCount: payload.productCount,
              paymentMethod: payload.paymentMethod ?? null,
              shippingProvider: payload.shippingProvider ?? null,
              shippingType: payload.shippingType ?? null,
              shippingPrice: payload.shippingPrice ?? null,
              shippingWilaya: payload.shippingWilaya ?? payload.wilaya ?? null,
              shippingCommune: payload.shippingCommune ?? payload.commune ?? payload.city ?? null,
              shippingStopdesk: payload.shippingStopdesk ?? null,
              shippingOfficeId: payload.shippingOfficeId ?? null,
              hasActiveDeliveryAccounts,
              isCod: payload.isCod,
              globalReputation
            },
            intelligence: {
              localRisk: {
                score: risk.breakdown?.localRiskScore ?? null,
                reasons: (risk.breakdown?.explanations ?? [])
                  .filter((item) => item.source === "LOCAL")
                  .map((item) => `${item.impact >= 0 ? "+" : ""}${item.impact} ${item.label}`)
              },
              networkReputation: {
                score: networkIntelligence.score,
                level: networkIntelligence.level,
                recommendation: networkIntelligence.recommendation,
                reasons: networkIntelligence.reasons,
                metrics: {
                  totalOrders: globalReputation?.totalOrders ?? 0,
                  delivered: globalReputation?.deliveredOrders ?? 0,
                  returned: globalReputation?.returnedOrders ?? 0,
                  refused: globalReputation?.refusedOrders ?? 0,
                  cancelled: globalReputation?.cancelledOrders ?? 0,
                  merchantCount: globalReputation?.merchantCount ?? 0,
                  firstSeen: globalReputation?.firstSeen ?? null,
                  lastSeen: globalReputation?.lastSeen ?? null,
                  providerCount: globalReputation?.providerCount ?? 0,
                  deliveryRate: networkIntelligence.metrics.deliveryRate,
                  cancellationRate: networkIntelligence.metrics.cancellationRate
                }
              },
              identityFingerprint: {
                confidence: identityInsights.confidence,
                confidenceScore: identityInsights.confidenceScore,
                linkedIdentityCount: identityInsights.linkedIdentityCount,
                phoneIdentityCount: identityInsights.phoneIdentityCount,
                reasons: identityInsights.reasons
              },
              fraudCluster: {
                score: clusterInsights.score,
                summary: clusterInsights.summary,
                reasons: clusterInsights.reasons,
                addressLinkedRefusedCustomers: clusterInsights.addressLinkedRefusedCustomers,
                phoneIdentityCount: clusterInsights.phoneIdentityCount
              },
              recommendedAction: {
                level: risk.level,
                action: risk.action,
                finalScore: risk.score
              },
              explanations: (risk.breakdown?.explanations ?? [])
                .sort((left, right) => Math.abs(right.impact) - Math.abs(left.impact))
                .map((item) => ({
                  source: item.source,
                  label: item.label,
                  impact: item.impact
                })),
              customerNetworkProfile: {
                totalOrders: customerNetworkProfile.totalOrders,
                deliveredOrders: customerNetworkProfile.deliveredOrders,
                refusedOrders: customerNetworkProfile.refusedOrders,
                returnedOrders: customerNetworkProfile.returnedOrders,
                cancelledOrders: customerNetworkProfile.cancelledOrders,
                noAnswerOrders: customerNetworkProfile.noAnswerOrders,
                fakeOrderCount: customerNetworkProfile.fakeOrderCount,
                merchantCount: customerNetworkProfile.merchantCount,
                providerCount: customerNetworkProfile.providerCount,
                deliverySuccessRate: customerNetworkProfile.deliverySuccessRate,
                averageOrderValue: customerNetworkProfile.averageOrderValue,
                estimatedDamageDzd: customerNetworkProfile.estimatedDamageDzd,
                merchantImpactScore: customerNetworkProfile.merchantImpactScore,
                networkTrustLevel: customerNetworkProfile.networkTrustLevel,
                merchantConfidenceScore: customerNetworkProfile.merchantConfidenceScore,
                riskTrend: customerNetworkProfile.riskTrend,
                firstSeen: customerNetworkProfile.firstSeen,
                lastSeen: customerNetworkProfile.lastSeen,
                linkedNames: customerNetworkProfile.linkedNames,
                linkedAddresses: customerNetworkProfile.linkedAddresses,
                linkedWilayas: customerNetworkProfile.linkedWilayas,
                networkInsights: customerNetworkProfile.networkInsights
              }
            }
          }
        });

        if (riskEventError) {
          console.error("[DZFS] check-order insert_risk_event_failed", riskEventError.message);
        }

        const notificationSettings = await getMerchantNotificationSettings(keyRecord.merchant_id);
        const baseMetadata = {
          orderCheckId: data.id,
          orderId: payload.orderId ?? null,
          customerName: payload.customerName ?? null,
          wilaya: payload.wilaya ?? null,
          amount: resolvedTotal,
          riskLevel: riskLevelForStorage,
          recommendedAction: risk.action,
        };

        const insertMerchantNotification = async (row: Record<string, unknown>) => {
          let result = await supabase.from("merchant_notifications").insert(row);
          if (result.error && /(notification_type|title|deleted_at)/i.test(result.error.message ?? "")) {
            const fallback = {
              merchant_id: row.merchant_id,
              level: row.level,
              event_type: row.event_type,
              message: row.message,
              metadata: row.metadata,
              provider: row.provider ?? null,
            };
            result = await supabase.from("merchant_notifications").insert(fallback);
          }

          return result;
        };

        console.log("[check-order] Stage 5: notification settings", { merchantId: keyRecord.merchant_id, allowsNewOrder: allowsNotification(notificationSettings, "new_order"), preferredLanguage: notificationSettings.preferredLanguage });
        if (allowsNotification(notificationSettings, "new_order")) {
          const localized = buildNewOrderNotification({
            locale: notificationSettings.preferredLanguage,
            customerName: payload.customerName ?? null,
            wilaya: payload.wilaya ?? null,
            amount: Number(resolvedTotal ?? 0),
            riskLevel: riskLevelForStorage,
          });

          await insertMerchantNotification({
            merchant_id: keyRecord.merchant_id,
            level: "info",
            event_type: "new_order_requires_review",
            notification_type: "new_order",
            title: localized.title,
            message: localized.body,
            metadata: baseMetadata,
          });

          const jobId = await enqueueBackgroundJob({
            type: "send_push_notification",
            merchantId: keyRecord.merchant_id,
            payload: {
              title: localized.title,
              body: localized.body,
              url: `/dashboard/checks/${data.id}`,
              data: baseMetadata,
            },
          });
          console.log("[check-order] Stage 5 OK: send_push_notification job enqueued", { jobId, merchantId: keyRecord.merchant_id, title: localized.title });
        } else {
          console.warn("[check-order] Stage 5: new_order notification suppressed by settings", { merchantId: keyRecord.merchant_id });
        }

        if (risk.action === "verify" && allowsNotification(notificationSettings, "risk_alert")) {
          const localized = buildRiskReviewNotification({
            locale: notificationSettings.preferredLanguage,
            customerName: payload.customerName ?? null,
            riskLevel: riskLevelForStorage,
          });

          await insertMerchantNotification({
            merchant_id: keyRecord.merchant_id,
            level: "warning",
            event_type: "order_needs_confirmation",
            notification_type: "risk_alert",
            title: localized.title,
            message: localized.body,
            metadata: baseMetadata,
          });

          await enqueueBackgroundJob({
            type: "send_push_notification",
            merchantId: keyRecord.merchant_id,
            payload: {
              title: localized.title,
              body: localized.body,
              url: "/dashboard/call-center",
              data: baseMetadata,
            },
          });
        }

      } catch (sideEffectError) {
        console.error("[DZFS] check-order post_response_side_effect_failed", sideEffectError);
      }
    })();
    segmentMs.notificationEnqueue = performance.now() - notificationEnqueueStarted;

    segmentMs.total = performance.now() - requestStart;

    const response = NextResponse.json({
      riskScore: merchantReputation.riskScore,
      trustLevel: merchantReputation.trustLevel,
      why: merchantReputation.reasons,
      estimatedDamage: merchantReputation.estimatedDamageDzd,
      recommendedAction: merchantReputation.recommendedAction,
      customerType: localHistory.customerType,
      localHistory,
      score: risk.score,
      level: riskLevelForStorage,
      reasons: risk.reasons,
      checkId: data.id,
      deliveryProviderConnected: hasActiveDeliveryAccounts,
      duplicate: false,
    });
    response.headers.set(
      "server-timing",
      `auth;dur=${segmentMs.authApiKeyValidation.toFixed(2)},merchant;dur=${segmentMs.merchantAccountLookup.toFixed(2)},risk_profile;dur=${segmentMs.riskProfileLookup.toFixed(2)},risk_history;dur=${segmentMs.riskHistoryLookup.toFixed(2)},scoring;dur=${segmentMs.scoring.toFixed(2)},insert;dur=${segmentMs.orderCheckInsert.toFixed(2)},enqueue;dur=${segmentMs.notificationEnqueue.toFixed(2)},total;dur=${segmentMs.total.toFixed(2)}`,
    );
    response.headers.set("x-dz-api-segments", JSON.stringify(segmentMs));
    response.headers.set("x-dz-risk-diagnostics", JSON.stringify(unified.diagnostics));
    response.headers.set("x-dz-risk-rpc-snapshot-ms", unified.diagnostics.rpcSnapshotMs.toFixed(2));
    response.headers.set("x-dz-risk-fallback-used", String(unified.diagnostics.fallbackUsed));
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("[DZFS] check-order validation_failed", JSON.stringify(error.issues));
      return NextResponse.json({ error: "Validation failed", issues: error.issues }, { status: 400 });
    }

    console.error("[DZFS] check-order internal_error", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
