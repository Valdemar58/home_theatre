import { Suspense } from "react";
import { SettingsView } from "@/components/SettingsView";
import { Spinner } from "@/components/ui";

export const metadata = { title: "Настройки" };

export default function SettingsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <SettingsView />
    </Suspense>
  );
}
