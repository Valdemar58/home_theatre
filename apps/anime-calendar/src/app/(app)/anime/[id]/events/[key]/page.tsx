import { EventView } from "@/components/Events";

export const metadata = { title: "Событие" };

export default async function EventPage({ params }: { params: Promise<{ id: string; key: string }> }) {
  const { id, key } = await params;
  return <EventView id={Number(id)} eventKey={decodeURIComponent(key)} />;
}
