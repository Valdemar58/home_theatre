import { BookView } from "@/components/books/BookView";

export const metadata = { title: "Книга" };

export default async function BookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BookView id={Number(id)} />;
}
