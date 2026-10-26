import { Suspense } from "react";
import { SharedListView } from "@/components/SharedListView";
import { Spinner } from "@/components/ui";

export const metadata = { title: "Общий список" };

export default async function SharedListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Suspense fallback={<Spinner />}><SharedListView id={Number(id)} /></Suspense>;
}
