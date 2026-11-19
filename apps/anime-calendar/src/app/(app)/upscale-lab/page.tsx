import { redirect } from "next/navigation";
import { UpscaleLab } from "@/components/UpscaleLab";
import { currentUser } from "@/server/session";

// Лаборатория апскейла гоняет модель — только админ
export default async function UpscaleLabPage() {
  if (!(await currentUser())?.is_admin) redirect("/calendar");
  return <UpscaleLab />;
}
