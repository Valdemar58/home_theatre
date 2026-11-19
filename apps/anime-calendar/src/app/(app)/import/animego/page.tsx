import { redirect } from "next/navigation";
import { AnimegoImportView } from "@/components/AnimegoImportView";
import { currentUser } from "@/server/session";

export const metadata = { title: "Импорт AnimeGo" };

// Проверка разового импорта списка AnimeGo — только админ
export default async function AnimegoImportPage() {
  if (!(await currentUser())?.is_admin) redirect("/calendar");
  return <AnimegoImportView />;
}
