import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/delivery-intelligence/accounts", () => ({
  getSyncableDeliveryAccounts: vi.fn(async () => []),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  enforceRateLimit: vi.fn(() => true),
}));

type Row = Record<string, any>;

type InMemoryState = {
  merchant_shipments: Row[];
  delivery_orders: Row[];
  merchant_notifications: Row[];
  delivery_webhook_events: Row[];
  background_jobs: Row[];
  order_checks: Row[];
};

const hoisted = vi.hoisted(() => ({
  testState: createState(),
  recomputeIdentityReputationMock: vi.fn(async () => undefined),
  deliverMerchantPushNotificationsMock: vi.fn(async () => ({ sent: 0, failed: 0, skipped: 0 })),
  allowsShipmentNotifications: true,
  preferredLanguage: "fr",
}));

vi.mock("@/lib/notifications/settings", () => ({
  getMerchantNotificationSettings: vi.fn(async () => ({
    merchantId: "merchant-1",
    preferredLanguage: hoisted.preferredLanguage,
    enableNotifications: true,
    enableNewOrder: true,
    enableShipmentUpdates: hoisted.allowsShipmentNotifications,
    enableRiskAlerts: true,
    permissionState: "granted",
    permissionPromptedAt: null,
  })),
  allowsNotification: vi.fn((_settings, category: string) => category !== "shipment_update" || hoisted.allowsShipmentNotifications),
}));

class TableQuery {
  private readonly table: keyof InMemoryState;
  private readonly state: InMemoryState;
  private filters: Array<{ column: string; value: unknown }> = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private limitValue: number | null = null;
  private mode: "select" | "update" = "select";
  private updateValues: Row = {};

  constructor(table: keyof InMemoryState, state: InMemoryState) {
    this.table = table;
    this.state = state;
  }

  public select() {
    return this;
  }

  public update(values: Row) {
    this.mode = "update";
    this.updateValues = values;
    return this;
  }

  public insert(payload: Row) {
    if (this.table === "merchant_notifications") {
      this.state.merchant_notifications.push({ id: `notif-${this.state.merchant_notifications.length + 1}`, ...payload });
      return Promise.resolve({ error: null });
    }

    if (this.table === "delivery_webhook_events") {
      const inserted = { id: `evt-${this.state.delivery_webhook_events.length + 1}`, ...payload };
      this.state.delivery_webhook_events.push(inserted);
      return {
        select: () => ({
          single: async () => ({ data: { id: inserted.id }, error: null })
        })
      };
    }

    if (this.table === "background_jobs") {
      if (Array.isArray(payload)) {
        for (const row of payload) {
          this.state.background_jobs.push({ id: `job-${this.state.background_jobs.length + 1}`, ...row });
        }
      } else {
        this.state.background_jobs.push({ id: `job-${this.state.background_jobs.length + 1}`, ...payload });
      }
      return Promise.resolve({ error: null });
    }

    return Promise.resolve({ error: null });
  }

  public upsert(row: Row) {
    if (this.table !== "delivery_orders") {
      return Promise.resolve({ error: null });
    }

    const index = this.state.delivery_orders.findIndex((item) => (
      item.merchant_id === row.merchant_id
      && item.provider === row.provider
      && item.external_order_id === row.external_order_id
    ));

    if (index >= 0) {
      this.state.delivery_orders[index] = {
        ...this.state.delivery_orders[index],
        ...row,
      };
    } else {
      this.state.delivery_orders.push({
        id: `do-${this.state.delivery_orders.length + 1}`,
        ...row,
      });
    }

    return Promise.resolve({ error: null });
  }

  public eq(column: string, value: unknown) {
    if (this.mode === "update") {
      const rows = this.getRows();
      const filtered = rows.filter((row) => row[column] === value);
      for (const rowToUpdate of filtered) {
        Object.assign(rowToUpdate, this.updateValues);
      }
      return Promise.resolve({ error: null });
    }

    this.filters.push({ column, value });
    return this;
  }

  public order(column: string, options?: { ascending?: boolean }) {
    this.orderBy = { column, ascending: options?.ascending !== false };
    return this;
  }

  public limit(value: number) {
    this.limitValue = value;
    return this;
  }

  public async maybeSingle() {
    const rows = this.getRows();
    return { data: rows[0] ?? null, error: null };
  }

  private getRows(): Row[] {
    let rows = [...this.state[this.table]];
    for (const filter of this.filters) {
      rows = rows.filter((row) => row[filter.column] === filter.value);
    }

    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      rows.sort((left, right) => {
        const leftValue = left[column];
        const rightValue = right[column];
        if (leftValue === rightValue) return 0;
        if (leftValue === undefined || leftValue === null) return ascending ? -1 : 1;
        if (rightValue === undefined || rightValue === null) return ascending ? 1 : -1;
        if (leftValue < rightValue) return ascending ? -1 : 1;
        return ascending ? 1 : -1;
      });
    }

    if (this.limitValue !== null) {
      rows = rows.slice(0, this.limitValue);
    }

    return rows;
  }
}

function createState(): InMemoryState {
  return {
    merchant_shipments: [],
    delivery_orders: [],
    merchant_notifications: [],
    delivery_webhook_events: [],
    background_jobs: [],
    order_checks: [],
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from: (table: keyof InMemoryState) => new TableQuery(table, hoisted.testState),
  }),
}));

vi.mock("@/lib/delivery-intelligence/reputation", () => ({
  recomputeIdentityReputation: hoisted.recomputeIdentityReputationMock,
}));

vi.mock("@/lib/pwa/push-delivery", () => ({
  deliverMerchantPushNotifications: hoisted.deliverMerchantPushNotificationsMock,
}));

describe("delivery webhook route", () => {
  beforeEach(() => {
    hoisted.testState.merchant_shipments = [];
    hoisted.testState.delivery_orders = [];
    hoisted.testState.merchant_notifications = [];
    hoisted.testState.delivery_webhook_events = [];
    hoisted.testState.background_jobs = [];
    hoisted.testState.order_checks = [];
    vi.clearAllMocks();
    process.env.DELIVERY_WEBHOOK_SECRET = "test-webhook-secret";
    hoisted.allowsShipmentNotifications = true;
    hoisted.preferredLanguage = "fr";
  });

  it("fails closed when webhook secret is not configured", async () => {
    delete process.env.DELIVERY_WEBHOOK_SECRET;
    const { POST } = await import("@/app/api/v1/delivery/webhooks/[provider]/route");
    const req = new NextRequest("http://localhost:3000/api/v1/delivery/webhooks/zr_express", {
      method: "POST",
      body: JSON.stringify({ tracking_number: "TRK-1", status: "DELIVERED" }),
    });

    const res = await POST(req, { params: { provider: "zr_express" } as any });
    expect(res.status).toBe(503);
  });

  it("rejects webhook when secret is invalid", async () => {
    const { POST } = await import("@/app/api/v1/delivery/webhooks/[provider]/route");
    const req = new NextRequest("http://localhost:3000/api/v1/delivery/webhooks/zr_express", {
      method: "POST",
      headers: {
        "x-webhook-secret": "wrong-secret",
      },
      body: JSON.stringify({ tracking_number: "TRK-1", status: "DELIVERED" }),
    });

    const res = await POST(req, { params: { provider: "zr_express" } as any });
    expect(res.status).toBe(401);
  });

  it("fails safely for unsupported providers", async () => {
    const { POST } = await import("@/app/api/v1/delivery/webhooks/[provider]/route");
    const req = new NextRequest("http://localhost:3000/api/v1/delivery/webhooks/unknown", {
      method: "POST",
      headers: {
        "x-webhook-secret": "test-webhook-secret",
      },
      body: JSON.stringify({ tracking_number: "TRK-1", status: "DELIVERED" }),
    });

    const res = await POST(req, { params: { provider: "unknown" } as any });
    expect(res.status).toBe(400);
  });

  it("updates merchant_shipments by shipment_id and keeps downstream persistence working", async () => {
    const { POST } = await import("@/app/api/v1/delivery/webhooks/[provider]/route");
    hoisted.testState.merchant_shipments.push({
      id: "ms-1",
      merchant_id: "11111111-1111-4111-8111-111111111111",
      provider: "zr_express",
      order_check_id: "oc-1",
      shipment_id: "85951098-d23e-411b-b9bf-45e20f5d8420",
      tracking_number: null,
      shipment_status: "CREATED",
      created_at: "2026-06-12T13:40:08.16847+00:00",
      updated_at: "2026-06-12T13:41:53.866+00:00",
    });

    const req = new NextRequest("http://localhost:3000/api/v1/delivery/webhooks/zr_express", {
      method: "POST",
      headers: {
        "x-webhook-secret": "test-webhook-secret",
      },
      body: JSON.stringify({
        merchant_id: "11111111-1111-4111-8111-111111111111",
        shipment_id: "85951098-d23e-411b-b9bf-45e20f5d8420",
        tracking_number: "16-CDQQ371F86-ZR",
        external_order_id: "audit-zr-real-1781271587",
        status: "DELIVERED",
      }),
    });

    const res = await POST(req, { params: { provider: "zr_express" } as any });
    expect(res.status).toBe(200);

    expect(hoisted.testState.merchant_shipments[0]).toMatchObject({
      shipment_status: "DELIVERED",
      tracking_number: "16-CDQQ371F86-ZR",
      shipment_id: "85951098-d23e-411b-b9bf-45e20f5d8420",
    });

    expect(hoisted.testState.delivery_orders[0]).toMatchObject({
      provider: "zr_express",
      external_order_id: "audit-zr-real-1781271587",
      tracking_number: "16-CDQQ371F86-ZR",
      status: "DELIVERED",
      normalized_outcome_reason: "DELIVERED",
    });

    expect(hoisted.testState.merchant_notifications.some((entry) => entry.event_type === "shipment_delivered")).toBe(true);
    expect(hoisted.testState.delivery_webhook_events.some((entry) => entry.processing_status === "processed" && entry.normalized_status === "DELIVERED")).toBe(true);
    expect(hoisted.testState.background_jobs.some((entry) => entry.type === "process_webhook_side_effects")).toBe(true);
    expect(hoisted.testState.background_jobs.some((entry) => entry.type === "refresh_dashboard_metrics")).toBe(true);
  });

  it("updates merchant_shipments by tracking_number and writes in-transit event data", async () => {
    const { POST } = await import("@/app/api/v1/delivery/webhooks/[provider]/route");
    hoisted.testState.merchant_shipments.push({
      id: "ms-2",
      merchant_id: "22222222-2222-4222-8222-222222222222",
      provider: "zr_express",
      order_check_id: "oc-2",
      shipment_id: null,
      tracking_number: "16-CDQQ371F86-ZR",
      shipment_status: "CREATED",
      created_at: "2026-06-12T13:40:08.16847+00:00",
      updated_at: "2026-06-12T13:41:53.866+00:00",
    });

    const req = new NextRequest("http://localhost:3000/api/v1/delivery/webhooks/zr_express", {
      method: "POST",
      headers: {
        "x-webhook-secret": "test-webhook-secret",
      },
      body: JSON.stringify({
        merchant_id: "22222222-2222-4222-8222-222222222222",
        shipment_id: "85951098-d23e-411b-b9bf-45e20f5d8420",
        tracking_number: "16-CDQQ371F86-ZR",
        external_order_id: "audit-zr-real-1781271587",
        status: "IN_TRANSIT",
      }),
    });

    const res = await POST(req, { params: { provider: "zr_express" } as any });
    expect(res.status).toBe(200);

    expect(hoisted.testState.merchant_shipments[0]).toMatchObject({
      shipment_status: "IN_TRANSIT",
      tracking_number: "16-CDQQ371F86-ZR",
      shipment_id: "85951098-d23e-411b-b9bf-45e20f5d8420",
    });

    expect(hoisted.testState.delivery_orders[0]).toMatchObject({
      provider: "zr_express",
      status: "IN_TRANSIT",
      tracking_number: "16-CDQQ371F86-ZR",
    });

    expect(hoisted.testState.merchant_notifications.some((entry) => entry.event_type === "shipment_in_transit")).toBe(true);
    expect(hoisted.testState.delivery_webhook_events.some((entry) => entry.processing_status === "processed" && entry.normalized_status === "IN_TRANSIT")).toBe(true);
    expect(hoisted.testState.merchant_notifications[0]?.message).toBe("Expédition en cours");
  });

  it("skips shipment notifications when merchant disables shipment updates", async () => {
    hoisted.allowsShipmentNotifications = false;
    const { POST } = await import("@/app/api/v1/delivery/webhooks/[provider]/route");
    hoisted.testState.merchant_shipments.push({
      id: "ms-4",
      merchant_id: "44444444-4444-4444-8444-444444444444",
      provider: "zr_express",
      order_check_id: "oc-4",
      shipment_id: "ship-4",
      tracking_number: "TRK-4",
      shipment_status: "CREATED",
      created_at: "2026-06-12T13:40:08.16847+00:00",
      updated_at: "2026-06-12T13:41:53.866+00:00",
    });

    const req = new NextRequest("http://localhost:3000/api/v1/delivery/webhooks/zr_express", {
      method: "POST",
      headers: {
        "x-webhook-secret": "test-webhook-secret",
      },
      body: JSON.stringify({
        merchant_id: "44444444-4444-4444-8444-444444444444",
        shipment_id: "ship-4",
        tracking_number: "TRK-4",
        external_order_id: "order-4",
        status: "DELIVERED",
      }),
    });

    const res = await POST(req, { params: { provider: "zr_express" } as any });
    expect(res.status).toBe(200);
    expect(hoisted.testState.merchant_notifications).toHaveLength(0);
    expect(hoisted.testState.background_jobs.some((entry) => entry.type === "process_webhook_side_effects")).toBe(true);
    expect(hoisted.testState.background_jobs.some((entry) => entry.type === "refresh_dashboard_metrics")).toBe(true);
  });

  it("treats duplicate webhook payloads as idempotent no-op", async () => {
    const { POST } = await import("@/app/api/v1/delivery/webhooks/[provider]/route");
    hoisted.testState.merchant_shipments.push({
      id: "ms-3",
      merchant_id: "33333333-3333-4333-8333-333333333333",
      provider: "zr_express",
      order_check_id: "oc-3",
      shipment_id: "ship-3",
      tracking_number: "TRK-3",
      shipment_status: "CREATED",
      created_at: "2026-06-12T13:40:08.16847+00:00",
      updated_at: "2026-06-12T13:41:53.866+00:00",
    });

    const payload = {
      merchant_id: "33333333-3333-4333-8333-333333333333",
      shipment_id: "ship-3",
      tracking_number: "TRK-3",
      external_order_id: "order-3",
      status: "DELIVERED",
      event_timestamp: "2026-06-14T10:30:00.000Z",
    };

    const requestInit = {
      method: "POST",
      headers: { "x-webhook-secret": "test-webhook-secret" },
      body: JSON.stringify(payload),
    } as const;

    const first = await POST(
      new NextRequest("http://localhost:3000/api/v1/delivery/webhooks/zr_express", requestInit),
      { params: { provider: "zr_express" } as any }
    );
    const second = await POST(
      new NextRequest("http://localhost:3000/api/v1/delivery/webhooks/zr_express", requestInit),
      { params: { provider: "zr_express" } as any }
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ duplicate: true });
    expect(hoisted.testState.delivery_orders).toHaveLength(1);
    expect(hoisted.testState.merchant_notifications).toHaveLength(1);
    expect(hoisted.testState.background_jobs.some((entry) => entry.type === "process_webhook_side_effects")).toBe(true);
  });
});
