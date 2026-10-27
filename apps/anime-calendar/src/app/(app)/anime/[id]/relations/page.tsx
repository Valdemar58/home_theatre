import { RelationMapView } from "@/components/RelationMapView";

export const metadata = { title: "Карта персонажей" };

export default async function RelationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RelationMapView id={Number(id)} />;
}
