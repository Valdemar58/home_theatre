import { Suspense } from "react";
import { CalendarView } from "@/components/calendar/CalendarView";
import { Spinner } from "@/components/ui";

export const metadata = { title: "Календарь" };

export default function CalendarPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <CalendarView />
    </Suspense>
  );
}
