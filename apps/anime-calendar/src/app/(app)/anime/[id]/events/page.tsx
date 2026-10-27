import { TitleEventsView } from "@/components/Events";

export const metadata = { title: "События" };

export default async function TitleEventsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TitleEventsView id={Number(id)} />;
}
