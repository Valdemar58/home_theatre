import { Suspense } from "react";
import { ListsView } from "@/components/ListsView";
import { Spinner } from "@/components/ui";

export const metadata = { title: "Мои списки" };

export default function ListsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ListsView />
    </Suspense>
  );
}
