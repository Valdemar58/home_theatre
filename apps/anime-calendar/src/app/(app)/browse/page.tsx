import { Suspense } from "react";
import { BrowseView } from "@/components/BrowseView";
import { Spinner } from "@/components/ui";

export const metadata = { title: "Каталог" };

export default function BrowsePage() {
  return (
    <Suspense fallback={<Spinner />}>
      <BrowseView />
    </Suspense>
  );
}
