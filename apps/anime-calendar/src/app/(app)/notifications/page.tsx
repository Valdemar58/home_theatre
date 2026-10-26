import { Suspense } from "react";
import { NotificationsView } from "@/components/NotificationsView";
import { Spinner } from "@/components/ui";

export const metadata = { title: "Уведомления" };

export default function NotificationsPage() {
  return <Suspense fallback={<Spinner />}><NotificationsView /></Suspense>;
}
