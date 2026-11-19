import { redirect } from "next/navigation";

// Группы переехали в своё меню — старые ссылки (уведомления) ведут туда
export default async function OldSharedListsPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = new URLSearchParams(await searchParams).toString();
  redirect(`/groups${q ? `?${q}` : ""}`);
}
