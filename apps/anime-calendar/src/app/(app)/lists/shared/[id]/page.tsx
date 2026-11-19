import { redirect } from "next/navigation";

// Группы переехали в своё меню — старые ссылки (уведомления) ведут туда
export default async function OldSharedListPage({ params }: { params: Promise<{ id: string }> }) {
  redirect(`/groups/${(await params).id}`);
}
