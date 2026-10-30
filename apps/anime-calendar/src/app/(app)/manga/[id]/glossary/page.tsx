import { GlossaryPage } from "@/components/GlossaryPage";

export const metadata = { title: "Глоссарий" };

export default async function BookGlossary({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GlossaryPage book={Number(id)} />;
}
