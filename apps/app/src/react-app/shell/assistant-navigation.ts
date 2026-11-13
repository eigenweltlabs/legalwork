import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";

type AssistantClient = Pick<LegalworkServerClient, "baseUrl" | "mainAssistantCurrent">;

/** Initialization is explicit work, never a background polling or retry job. */
export function currentAssistantQuery(client: AssistantClient | null, projectFields?: Parameters<AssistantClient["mainAssistantCurrent"]>[0]) {
  return queryOptions({
    queryKey: ["main-assistant", client?.baseUrl],
    enabled: false,
    retry: false,
    queryFn: () => {
      if (!client) throw new Error("Server unavailable");
      return client.mainAssistantCurrent(projectFields);
    },
    staleTime: 0,
  });
}

export function savedAssistantQuery(client: LegalworkServerClient | null) {
  return queryOptions({
    queryKey: ["main-assistant-profile", client?.baseUrl],
    enabled: Boolean(client),
    retry: false,
    refetchInterval: 30_000,
    queryFn: () => {
      if (!client) throw new Error("Server unavailable");
      return client.mainAssistantProfile();
    },
  });
}

/** The server's saved identity is enough to browse history while online checks run. */
export function seedSavedAssistant(cache: QueryClient, baseUrl: string, saved: Awaited<ReturnType<LegalworkServerClient["mainAssistantProfile"]>>) {
  if (!saved.workspace || !saved.day) return;
  const current = { workspace: saved.workspace, day: saved.day, profile: saved.profile };
  cache.setQueryData<Awaited<ReturnType<LegalworkServerClient["mainAssistantCurrent"]>>>(["main-assistant", baseUrl], previous => {
    if (!previous || previous.day.date < current.day.date) return current;
    if (previous.profile.name === current.profile.name && previous.profile.icon === current.profile.icon) return previous;
    return { ...previous, profile: current.profile };
  });
  if (saved.onboarding) cache.setQueryData(["assistant-onboarding", baseUrl], saved.onboarding);
}

/** Navigation can reuse today's identity; tomorrow still resolves a fresh chat. */
export async function resolveAssistantChat(
  client: AssistantClient,
  cache: QueryClient,
  now = new Date(),
  projectFields?: Parameters<AssistantClient["mainAssistantCurrent"]>[0],
) {
  const queryKey = ["main-assistant", client.baseUrl];
  const current = cache.getQueryData<Awaited<ReturnType<LegalworkServerClient["mainAssistantCurrent"]>>>(queryKey);
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (current?.day.date === date) return current;
  return cache.fetchQuery(currentAssistantQuery(client, projectFields));
}
