import type { QueryClient } from "@tanstack/react-query";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";

/** Navigation can reuse today's identity; tomorrow still resolves a fresh chat. */
export async function resolveAssistantChat(
  client: Pick<LegalworkServerClient, "baseUrl" | "mainAssistantCurrent">,
  cache: QueryClient,
  now = new Date(),
) {
  const queryKey = ["main-assistant", client.baseUrl];
  const current = cache.getQueryData<Awaited<ReturnType<LegalworkServerClient["mainAssistantCurrent"]>>>(queryKey);
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (current?.day.date === date) return current;
  return cache.fetchQuery({ queryKey, queryFn: () => client.mainAssistantCurrent(), staleTime: 0 });
}
