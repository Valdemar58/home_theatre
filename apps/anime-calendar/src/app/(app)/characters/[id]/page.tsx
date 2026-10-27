import { CharacterView } from "@/components/Characters";

export const metadata = { title: "Персонаж" };

export default async function CharacterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CharacterView param={id} />;
}
