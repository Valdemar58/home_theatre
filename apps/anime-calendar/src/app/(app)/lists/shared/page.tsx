import { Suspense } from "react";
import { SharedListsView } from "@/components/SharedListsView";
import { Spinner } from "@/components/ui";

export const metadata = { title: "Общие списки" };

export default function SharedListsPage() {
  return <Suspense fallback={<Spinner />}><SharedListsView /></Suspense>;
}
