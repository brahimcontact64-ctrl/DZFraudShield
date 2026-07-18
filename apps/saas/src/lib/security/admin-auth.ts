import { NextRequest } from "next/server";

function decodeBasicUsername(req: NextRequest): string | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Basic ")) {
    return null;
  }

  try {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const [username] = decoded.split(":");
    return username ?? null;
  } catch {
    return null;
  }
}

function getSuperAdminUsernames(): string[] {
  const configured = process.env.SUPER_ADMIN_USERS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (configured.length > 0) {
    return configured;
  }

  if (process.env.SUPER_ADMIN_USER?.trim()) {
    return [process.env.SUPER_ADMIN_USER.trim()];
  }

  if (process.env.ADMIN_NETWORK_USER?.trim()) {
    return [process.env.ADMIN_NETWORK_USER.trim()];
  }

  return [];
}

export function isSuperAdminRequest(req: NextRequest): boolean {
  const username = decodeBasicUsername(req);
  if (!username) {
    return false;
  }

  const superAdmins = getSuperAdminUsernames();
  return superAdmins.includes(username);
}

export function getAdminActorId(req: NextRequest): string | null {
  return decodeBasicUsername(req) ?? process.env.ADMIN_NETWORK_USER ?? null;
}
