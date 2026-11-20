import { DownloadsWorkspace } from "@/components/DownloadsWorkspace";
import { currentUser } from "@/server/session";

// Раздачи и очередь — служебное: только админ
export default async function DownloadsPage({ searchParams }: { searchParams: Promise<{title?:string;name?:string}> }) {
  const user = await currentUser(), params = await searchParams;
  const id = Number(params.title);
  return <DownloadsWorkspace admin={Boolean(user?.is_admin)} title={Number.isSafeInteger(id) && id > 0 ? id : undefined} name={params.name?.slice(0,250)}/>;
}
