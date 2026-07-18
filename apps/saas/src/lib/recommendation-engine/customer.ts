// Customer intelligence recommendations.
//
// Signal source: MerchantIntelSummary (uniqueCustomers, orderGrowthRate, totalOrders)
//
// Note: Deep customer segmentation requires the customer_reputation table.
// The current data model exposes uniqueCustomers count per merchant.
// These recommendations are based on derived signals from available metrics.

import type { MerchantIntelSummary } from "@/lib/merchant-intelligence/types";
import type { Recommendation } from "./types";
import { calculateConfidence, growthSignalStrength } from "./scoring";

let _id = 0;
function nextId(): string {
  return `cus-${++_id}`;
}

export function resetCustomerIds(): void {
  _id = 0;
}

const NOW = new Date().toISOString();

// ── Thresholds ─────────────────────────────────────────────────────────────────

const MIN_CUSTOMERS        = 10;
const MIN_ORDERS           = 20;
const REPEAT_RATIO_GOOD    = 0.40; // >40% orders per unique customer → high retention
const REPEAT_RATIO_CONCERN = 0.10; // <10% orders per unique customer → nearly all new

// ── Customer recommendations ───────────────────────────────────────────────────

export function generateCustomerRecommendations(
  summaries: MerchantIntelSummary[],
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const m of summaries) {
    if (m.uniqueCustomers < MIN_CUSTOMERS) continue;
    if (m.totalOrders < MIN_ORDERS) continue;

    // Derived metric: avg orders per unique customer (proxy for repeat buying)
    const ordersPerCustomer = m.totalOrders / m.uniqueCustomers;

    // ── Strong repeat buyers ─────────────────────────────────────────────
    if (ordersPerCustomer >= REPEAT_RATIO_GOOD) {
      const signal = growthSignalStrength(ordersPerCustomer - REPEAT_RATIO_GOOD, 0.1);
      const confidence = calculateConfidence(m.totalOrders, signal);

      recs.push({
        id: nextId(),
        merchantId: m.merchantId,
        merchantName: m.name,
        category: "customer",
        type: "customer_repeat_buyers",
        priority: "MEDIUM",
        title: `${m.name} has strong repeat buyers — ${ordersPerCustomer.toFixed(1)} orders per customer`,
        description: `${m.uniqueCustomers.toLocaleString()} unique customers generated ${m.totalOrders.toLocaleString()} orders — an average of ${ordersPerCustomer.toFixed(1)} orders per customer. This indicates high customer retention and satisfaction.`,
        reason: `An orders-per-customer ratio above ${REPEAT_RATIO_GOOD} demonstrates that customers are returning to buy again. This is a powerful retention signal that should be amplified with a loyalty programme or re-engagement campaign.`,
        businessImpact: `Repeat customers are 3–5× cheaper to convert than new customers. Investing in retention programmes multiplies revenue without proportional acquisition spend.`,
        estimatedSavingsDzd: 0,
        estimatedRevenueIncreaseDzd: Math.round(m.grossRevenueDzd * 0.10),
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["customer_reputation", "order_checks"],
        recommendedActions: [
          { label: "Launch a loyalty programme", description: "Reward repeat customers with exclusive discounts or early access to new products." },
          { label: "Create a VIP customer segment", description: "Identify top 20% customers by order count and offer premium service." },
          { label: "Set up re-engagement campaigns", description: "Target customers who haven't ordered in 60+ days with a special offer." },
        ],
      });
    }

    // ── Very low repeat rate — nearly all new customers ──────────────────
    if (ordersPerCustomer <= REPEAT_RATIO_CONCERN && m.uniqueCustomers >= 20) {
      const signal = Math.max(0, REPEAT_RATIO_CONCERN - ordersPerCustomer) / REPEAT_RATIO_CONCERN;
      const confidence = calculateConfidence(m.totalOrders, signal);

      recs.push({
        id: nextId(),
        merchantId: m.merchantId,
        merchantName: m.name,
        category: "customer",
        type: "customer_new_declining",
        priority: "LOW",
        title: `${m.name} customer base is almost entirely new buyers`,
        description: `${m.uniqueCustomers.toLocaleString()} unique customers for ${m.totalOrders.toLocaleString()} orders — only ${ordersPerCustomer.toFixed(2)} orders per customer. The merchant is heavily dependent on new customer acquisition with almost no repeat buying.`,
        reason: `A very low orders-per-customer ratio means the merchant spends full acquisition cost on every order. Without retention, growth requires constant ad spend escalation, which is unsustainable.`,
        businessImpact: `Building even 20% repeat buyer rate would reduce effective customer acquisition cost significantly, improving overall margin.`,
        estimatedSavingsDzd: 0,
        estimatedRevenueIncreaseDzd: Math.round(m.grossRevenueDzd * 0.05),
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["customer_reputation", "order_checks"],
        recommendedActions: [
          { label: "Implement a post-purchase follow-up", description: "Contact customers 2 weeks after delivery to check satisfaction and introduce related products." },
          { label: "Create a re-order discount", description: "Offer 10–15% off the next purchase when a customer completes delivery." },
          { label: "Review product catalogue", description: "Low repeat rates may indicate customers have no reason to come back. Expand catalogue or add consumable products." },
        ],
      });
    }

    // ── High-value customer segment signal ───────────────────────────────
    // High basket + good delivery rate = customers worth targeting deeply
    if (
      m.avgBasketDzd >= 4000 &&
      m.deliverySuccessRate >= 0.60 &&
      m.uniqueCustomers >= 20
    ) {
      const confidence = calculateConfidence(m.totalOrders, 0.5);

      recs.push({
        id: nextId(),
        merchantId: m.merchantId,
        merchantName: m.name,
        category: "customer",
        type: "customer_high_value_segment",
        priority: "LOW",
        title: `${m.name} customers have a high average basket — ${(m.avgBasketDzd || 0).toFixed(0)} DZD`,
        description: `Average order value is ${(m.avgBasketDzd || 0).toFixed(0)} DZD with ${m.uniqueCustomers.toLocaleString()} unique customers and ${(m.deliverySuccessRate * 100).toFixed(1)}% delivery success. This is a high-value customer segment worth investing in.`,
        reason: `High average basket combined with good delivery rate indicates a customer segment with both purchasing power and genuine intent. These customers should be identified and targeted with premium offers.`,
        businessImpact: `A 10% increase in high-value customer orders at ${(m.avgBasketDzd || 0).toFixed(0)} DZD avg basket generates proportionally higher revenue than acquiring low-value customers.`,
        estimatedSavingsDzd: 0,
        estimatedRevenueIncreaseDzd: Math.round(m.uniqueCustomers * 0.1 * m.avgBasketDzd * m.deliverySuccessRate),
        confidenceScore: confidence,
        generatedAt: NOW,
        requiredDataSources: ["order_checks", "customer_reputation"],
        recommendedActions: [
          { label: "Create a high-value lookalike audience", description: "Use successful customer data to find similar high-value prospects for ad targeting." },
          { label: "Offer premium products to this segment", description: `With ${(m.avgBasketDzd || 0).toFixed(0)} DZD avg basket, customers here can absorb premium offers.` },
          { label: "Assign dedicated support", description: "High-value customers benefit from priority support which increases retention." },
        ],
      });
    }
  }

  return recs;
}
