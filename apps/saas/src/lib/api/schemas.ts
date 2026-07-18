import { z } from "zod";

const productItemSchema = z.object({
  productName: z.string().max(200),
  quantity: z.number().nonnegative(),
  itemTotal: z.number().nonnegative()
});

export const checkOrderSchema = z.object({
  orderId: z.string().max(100).optional(),
  storeId: z.string().uuid().optional(),
  phone: z.string().min(6).max(30).optional(),
  customerPhone: z.string().min(6).max(30).optional(),
  phoneHash: z.string().length(64).optional(),
  customerName: z.string().max(120).optional(),
  customerAddress: z.string().max(350).optional(),
  city: z.string().max(120).optional(),
  wilaya: z.string().max(120).optional(),
  commune: z.string().max(120).optional(),
  address: z.string().max(350).optional(),
  addressHash: z.string().length(64).optional(),
  productNames: z.array(z.string().max(200)).max(50).optional(),
  productItems: z.array(productItemSchema).max(50).optional(),
  ip: z.string().max(64).optional(),
  userAgent: z.string().max(500).optional(),
  cartTotal: z.number().nonnegative(),
  totalAmount: z.number().nonnegative().optional(),
  productCount: z.number().int().nonnegative(),
  paymentMethod: z.string().max(50).optional(),
  shippingProvider: z.string().max(80).optional(),
  shippingType: z.enum(["home", "stopdesk"]).optional(),
  shippingPrice: z.number().nonnegative().optional(),
  shippingWilaya: z.string().max(120).optional(),
  shippingCommune: z.string().max(120).optional(),
  shippingStopdesk: z.string().max(160).optional(),
  shippingOfficeId: z.string().max(120).optional(),
  isCod: z.boolean()
});

export const reportOutcomeSchema = z.object({
  orderCheckId: z.string().uuid(),
  outcome: z.enum(["delivered", "refused", "cancelled", "fake", "unreachable"]),
  notes: z.string().max(500).optional()
});

export const orderDecisionSchema = z.object({
  phone: z.string().min(6).max(30),
  customerName: z.string().max(120).optional(),
  address: z.string().max(350).optional(),
  wilaya: z.string().max(120).optional(),
  commune: z.string().max(120).optional()
});

export const merchantDecisionSchema = z.object({
  orderCheckId: z.string().uuid(),
  decision: z.enum(["ACCEPTED", "VERIFY_FIRST", "BLOCKED"]),
  decisionReason: z.string().max(300).optional(),
  notes: z.string().max(1000).optional()
});

export const merchantDecisionsListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional()
});
