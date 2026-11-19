import { Suspense } from "react";
import { Reader, ReaderLoading } from "@/components/books/Reader";

export const metadata = { title: "Чтение" };

export default async function ReadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Suspense fallback={<ReaderLoading />}><Reader id={Number(id)} /></Suspense>;
}
