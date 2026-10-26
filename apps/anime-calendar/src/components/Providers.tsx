"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { DialogsProvider } from "./Dialogs";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }),
  );
  return <QueryClientProvider client={client}><DialogsProvider>{children}</DialogsProvider></QueryClientProvider>;
}
