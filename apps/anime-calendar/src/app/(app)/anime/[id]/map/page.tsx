import { PlotMapView } from "@/components/PlotMapView";

export const metadata = { title: "Карта мест" };

export default async function PlotMapPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlotMapView id={Number(id)} />;
}
