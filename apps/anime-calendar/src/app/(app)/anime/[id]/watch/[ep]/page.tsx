import { WatchView } from "@/components/player/WatchView";

export const metadata = { title: "Просмотр" };

export default async function WatchPage({ params }: { params: Promise<{ id: string; ep: string }> }) {
  const { id, ep } = await params;
  return <WatchView id={Number(id)} ep={Number(ep)} />;
}
