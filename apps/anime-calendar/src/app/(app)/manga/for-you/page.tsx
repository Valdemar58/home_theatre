import { Suspense } from "react";
import { BookForYou } from "@/components/books/BookForYou";

export const metadata = { title: "Для тебя — книги" };

export default function BookForYouPage() {
  return <Suspense><BookForYou /></Suspense>;
}
