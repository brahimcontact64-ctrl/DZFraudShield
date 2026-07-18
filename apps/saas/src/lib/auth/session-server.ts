import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { DASHBOARD_SESSION_COOKIE } from "@/lib/auth/constants";

export function getDashboardAccessTokenFromCookies() {
  return cookies().get(DASHBOARD_SESSION_COOKIE)?.value ?? null;
}

export async function getDashboardSessionUser() {
  const accessToken = getDashboardAccessTokenFromCookies();
  if (!accessToken) {
    return null;
  }

  const supabase = createClient();
  const authClient = supabase.auth as any;
  const { data, error } = await authClient.getUser(accessToken);

  if (error || !data?.user) {
    return null;
  }

  return data.user;
}
