import { ProfilePrototypes } from "@/components/ProfilePrototypes";

export const metadata = { title: "Профиль — прототипы" };

export default async function ProfilePreviewPage({ searchParams }: { searchParams: Promise<{ user?: string }> }) {
  const { user } = await searchParams;
  return <ProfilePrototypes userId={Number(user) || undefined} />;
}
