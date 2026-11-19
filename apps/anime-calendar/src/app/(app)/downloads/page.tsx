import { DesktopDownloads } from "@/components/DesktopDownloads";
import { ServerDownloadStorage } from "@/components/ServerDownloadStorage";
import { DownloadsView } from "@/components/DownloadsView";
import { currentUser } from "@/server/session";

// Раздачи и очередь — служебное: только админ
export default async function DownloadsPage({ searchParams }: { searchParams: Promise<{title?:string;name?:string}> }) {
  const user = await currentUser(), params = await searchParams;
  const id = Number(params.title);
  return <div className="space-y-8"><h1 className="text-2xl font-bold">Загрузки</h1><DesktopDownloads title={Number.isSafeInteger(id) && id > 0 ? id : undefined} titleName={params.name?.slice(0,250)} />{Boolean(user?.is_admin) && <details className="border-t border-gray-700 pt-5"><summary className="cursor-pointer font-medium">Загрузки на медиасервере</summary><div className="mt-5 space-y-6"><ServerDownloadStorage /><details><summary className="cursor-pointer py-2 text-sm text-gray-300">Источники и очередь медиасервера</summary><div className="mt-4"><DownloadsView /></div></details></div></details>}</div>;
}
