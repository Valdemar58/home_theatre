import { PlacesView } from "@/components/Places";

export const metadata = { title: "Места" };

export default async function PlacesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlacesView id={Number(id)} />;
}
