"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@/lib/supabase/browser";
import { persistDashboardSession } from "@/lib/auth/session-client";
import { useI18n } from "@/lib/i18n/client";

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const supabase = createBrowserClient();
    const auth = supabase.auth as any;
    const { data, error } = await auth.signInWithPassword({ email, password });

    if (error) {
      setMessage(error.message);
      return;
    }

    if (data?.session?.access_token) {
      try {
        // Persisting the session also auto-provisions merchant + default API key.
        await persistDashboardSession(data.session.access_token);
      } catch (sessionError) {
        const msg = sessionError instanceof Error ? sessionError.message : t("auth.login.sessionError");
        setMessage(t("auth.login.loginFailed", { message: msg }));
        return;
      }
    }

    setMessage(t("auth.login.success"));
    router.push("/dashboard");
  }

  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-bold text-brand">{t("auth.login.title")}</h1>
      <form onSubmit={onSubmit} className="mt-6 space-y-3 rounded-2xl border border-slate-200 bg-white p-5">
        <input className="w-full rounded-lg border p-2" placeholder={t("auth.login.email")} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="w-full rounded-lg border p-2" placeholder={t("auth.login.password")} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="rounded-lg bg-brand px-4 py-2 font-semibold text-white" type="submit">{t("auth.login.submit")}</button>
      </form>
      {message ? <p className="mt-3 text-sm">{message}</p> : null}
    </main>
  );
}
