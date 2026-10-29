import { redirect } from "next/navigation";
import { DownloadsView } from "@/components/DownloadsView";
import { currentUser } from "@/server/session";

// Раздачи и очередь — служебное: только админ
export default async function DownloadsPage() {
  if (!(await currentUser())?.is_admin) redirect("/calendar");
  return <DownloadsView />;
}
