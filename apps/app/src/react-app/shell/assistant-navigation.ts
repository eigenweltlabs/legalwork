import type { QueryClient } from "@tanstack/react-query";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";

/** The server's saved identity is enough to browse history while online checks run. */
export function seedSavedAssistant(cache: QueryClient, baseUrl: string, saved: Awaited<ReturnType<LegalworkServerClient["mainAssistantProfile"]>>) {
  if (!saved.workspace || !saved.day) return;
  const current = { workspace: saved.workspace, day: saved.day, profile: saved.profile };
  cache.setQueryData<Awaited<ReturnType<LegalworkServerClient["mainAssistantCurrent"]>>>(["main-assistant", baseUrl], previous => previous ?? current);
  if (saved.onboarding) cache.setQueryData(["assistant-onboarding", baseUrl], saved.onboarding);
}

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
