import { headers } from "next/headers";
import { ssoConfigured } from "@/server/env";
import { LoginForm } from "./LoginForm";

// С единым входом — кнопка «Войти» (Authentik); пароль Jellyfin — запасной путь, только из дома
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const remote = (await headers()).get("x-public-access") === "1";
  return <LoginForm sso={ssoConfigured()} fallback={!ssoConfigured() || !remote} error={error ?? null} next={next ?? null} />;
}
