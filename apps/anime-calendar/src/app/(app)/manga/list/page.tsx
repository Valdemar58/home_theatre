import { Suspense } from "react";
import { BookList } from "@/components/books/BooksHome";

export const metadata = { title: "Мои списки — книги" };

export default function BookListPage() {
  return <Suspense><BookList /></Suspense>;
}
