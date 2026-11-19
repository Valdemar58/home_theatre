import { redirect } from "next/navigation";
import { AccountsView } from "@/components/AccountsView";
import { currentUser } from "@/server/session";

export const metadata = { title: "Пользователи" };

// Заявки, учётки и приглашения — только админ
export default async function AccountsPage() {
  if (!(await currentUser())?.is_admin) redirect("/calendar");
  return <AccountsView />;
}
