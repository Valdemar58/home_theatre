import { Suspense } from "react";
import { ProfileView } from "@/components/ProfileView";
import { Spinner } from "@/components/ui";

export const metadata = { title: "Профиль" };

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Списки внутри читают вкладку из адреса (useSearchParams) — нужен Suspense
  return <Suspense fallback={<Spinner />}><ProfileView id={Number(id)} /></Suspense>;
}
