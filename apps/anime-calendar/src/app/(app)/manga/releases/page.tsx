import { Suspense } from "react";
import { BookReleases } from "@/components/books/BookReleases";

export const metadata = { title: "Выход глав" };

export default function BookReleasesPage() {
  return <Suspense><BookReleases /></Suspense>;
}
