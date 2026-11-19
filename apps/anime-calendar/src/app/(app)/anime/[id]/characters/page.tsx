import { TitleCharactersView } from "@/components/Characters";

export const metadata = { title: "Персонажи" };

export default async function TitleCharactersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TitleCharactersView id={Number(id)} />;
}
