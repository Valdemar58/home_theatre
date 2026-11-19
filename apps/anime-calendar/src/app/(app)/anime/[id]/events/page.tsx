import { EventMapView } from "@/components/EventMap";

export const metadata = { title: "Карта событий" };

export default async function TitleEventsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EventMapView id={Number(id)} />;
}
