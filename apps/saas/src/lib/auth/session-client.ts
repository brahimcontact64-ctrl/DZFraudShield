import { DASHBOARD_SESSION_COOKIE } from "@/lib/auth/constants";

export async function persistDashboardSession(accessToken: string) {
  const response = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? "Failed to persist dashboard session");
  }
}

export async function clearDashboardSession() {
  await fetch("/api/auth/session", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" }
  }).catch(() => null);
}

export function getDashboardSessionCookieName() {
  return DASHBOARD_SESSION_COOKIE;
}
