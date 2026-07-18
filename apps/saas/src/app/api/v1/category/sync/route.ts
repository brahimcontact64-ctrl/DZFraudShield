import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { resolveDashboardMerchantId } from "@/lib/dashboard-data";
import { normalizeMerchantCategory } from "@/lib/merchant/categories";

export const dynamic = "force-dynamic";

type RequestAuth =
  | { kind: "admin" }
  | { kind: "merchant"; merchantId: string };

function getClientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip")?.trim() ?? "unknown";
}

function parseBasicAuth(authHeader: string | null): { username: string; password: string } | null {
  if (!authHeader?.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex < 0) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

function isAdminRequest(req: NextRequest): boolean {
  const expectedUser = process.env.ADMIN_NETWORK_USER;
  const expectedPassword = process.env.ADMIN_NETWORK_PASSWORD;
  if (!expectedUser || !expectedPassword) {
    return false;
  }

  const parsed = parseBasicAuth(req.headers.get("authorization"));
  if (!parsed) {
    return false;
  }

  return parsed.username === expectedUser && parsed.password === expectedPassword;
}

async function resolveRequestAuth(req: NextRequest): Promise<RequestAuth | null> {
  if (isAdminRequest(req)) {
    return { kind: "admin" };
  }

  const merchantId = await resolveDashboardMerchantId();
  if (!merchantId) {
    return null;
  }

  return { kind: "merchant", merchantId };
}

function enforceOwnership(auth: RequestAuth, requestedMerchantId: string): NextResponse | null {
  if (auth.kind === "admin") {
    return null;
  }

  if (auth.merchantId !== requestedMerchantId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return null;
}

export async function POST(req: NextRequest) {
  const clientIp = getClientIp(req);
  if (!await enforceRateLimit(`category-sync:${clientIp}`, 100, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const auth = await resolveRequestAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await req.json().catch(() => ({}));
    const merchantId = typeof payload?.merchantId === "string" ? payload.merchantId.trim() : "";
    const rawCategory = typeof payload?.category === "string" ? payload.category.trim() : "";

    if (!merchantId || !rawCategory) {
      return NextResponse.json({ error: "merchantId and category are required" }, { status: 400 });
    }

    const ownershipError = enforceOwnership(auth, merchantId);
    if (ownershipError) {
      return ownershipError;
    }

    const category = normalizeMerchantCategory(rawCategory);

    const supabase = createClient();
    const { error } = await supabase
      .from("merchants")
      .update({
        category,
        category_updated_at: new Date().toISOString(),
      })
      .eq("id", merchantId);

    if (error) {
      return NextResponse.json({ error: "Failed to update category" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      merchantId,
      category,
      timestamp: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({ error: "Failed to process category update" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const clientIp = getClientIp(req);
  if (!await enforceRateLimit(`category-sync-read:${clientIp}`, 120, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const auth = await resolveRequestAuth(req);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const merchantId = searchParams.get("merchantId")?.trim() ?? "";

  if (!merchantId) {
    return NextResponse.json({ error: "merchantId is required" }, { status: 400 });
  }

  const ownershipError = enforceOwnership(auth, merchantId);
  if (ownershipError) {
    return ownershipError;
  }

  const supabase = createClient();
  const { data, error } = await supabase
    .from("merchants")
    .select("id, category, category_updated_at")
    .eq("id", merchantId)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Merchant not found" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    merchantId: data.id,
    category: data.category,
    updatedAt: data.category_updated_at,
  });
}
