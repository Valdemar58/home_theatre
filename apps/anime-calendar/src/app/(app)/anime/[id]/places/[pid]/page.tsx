import { PlaceView } from "@/components/Places";

export const metadata = { title: "Место" };

export default async function PlacePage({ params }: { params: Promise<{ id: string; pid: string }> }) {
  const { id, pid } = await params;
  return <PlaceView id={Number(id)} placeId={Number(pid)} />;
}
