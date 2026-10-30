import { Suspense } from "react";
import { BooksHome } from "@/components/books/BooksHome";

export const metadata = { title: "Манга и ранобэ" };

export default function BooksPage() {
  // Манга или ранобэ — из адреса (useSearchParams) — нужен Suspense
  return <Suspense><BooksHome /></Suspense>;
}
