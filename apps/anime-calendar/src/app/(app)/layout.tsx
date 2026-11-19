import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { parseSidebarMode, SIDEBAR_COOKIE } from "@/lib/sidebar";
import { currentUser, authenticatedUser } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await currentUser();
  if (!user) redirect((await authenticatedUser()) ? "/access" : "/login");
  // Выбор панели кнопкой — в cookie: страница сразу приходит с нужной панелью, без мигания
  const sidebar = parseSidebarMode(
    (await cookies()).get(SIDEBAR_COOKIE)?.value,
  );
  return (
    <AppShell userName={user.name} sidebar={sidebar}>
      {children}
    </AppShell>
  );
}
