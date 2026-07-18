export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | "BLOCK";

export type RecommendedAction = "accept" | "verify" | "manual_review" | "block";

export interface RiskResult {
  score: number;
  level: RiskLevel;
  reasons: string[];
  action: RecommendedAction;
  breakdown?: {
    localRiskScore: number;
    networkRiskScore: number;
    finalRiskScore: number;
    identityConfidence?: "HIGH" | "MEDIUM" | "LOW";
    clusterRiskScore?: number;
    explanations: Array<{
      source: "LOCAL" | "NETWORK" | "IDENTITY" | "CLUSTER";
      label: string;
      impact: number;
    }>;
  };
}

export interface ProductItemInput {
  productName: string;
  quantity: number;
  itemTotal: number;
}

export interface OrderCheckInput {
  merchantId: string;
  storeId?: string;
  orderId?: string;
  phoneRaw?: string;
  customerPhone?: string;
  phoneHash?: string;
  customerName?: string;
  customerAddress?: string;
  city?: string;
  wilaya?: string;
  commune?: string;
  address?: string;
  productNames?: string[];
  productItems?: ProductItemInput[];
  ip?: string;
  userAgent?: string;
  cartTotal: number;
  totalAmount?: number;
  productCount: number;
  paymentMethod?: string;
  isCod: boolean;
}
