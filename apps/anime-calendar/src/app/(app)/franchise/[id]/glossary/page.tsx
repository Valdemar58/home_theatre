import { GlossaryPage } from "@/components/GlossaryPage";

export const metadata = { title: "Глоссарий" };

export default async function FranchiseGlossary({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GlossaryPage anime={Number(id)} />;
}
