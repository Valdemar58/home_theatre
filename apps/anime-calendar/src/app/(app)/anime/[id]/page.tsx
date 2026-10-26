import { AnimeDetailsView } from "@/components/AnimeDetailsView";

export default async function AnimePage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ voices?: string; together?: string; undo?: string; comment?: string }>;
}) {
  const { id } = await params;
  // ?voices=1 — пришли из уведомления «озвучки готовы»: сразу открыть список
  // ?together=N — из подсказки «отметить и для …?», ?undo=ID — из уведомления «вам отметили серии»,
  // ?comment=ID — из уведомления об ответе
  const { voices, together, undo, comment } = await searchParams;
  return <AnimeDetailsView id={Number(id)} openVoices={voices === "1"}
    together={Number(together) || undefined} undo={Number(undo) || undefined} comment={Number(comment) || undefined} />;
}
