import { FranchiseView } from "@/components/Franchise";

export const metadata = { title: "Франшиза" };

export default async function FranchisePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FranchiseView id={Number(id)} />;
}
