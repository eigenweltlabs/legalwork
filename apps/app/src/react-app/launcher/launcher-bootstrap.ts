import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";

/** Search and project navigation must load independently of Assistant access. */
export function launcherBootstrapQueries(client: Pick<LegalworkServerClient, "baseUrl" | "assistantConversationCurrent" | "listWorkspaces"> | null) {
  const shared = { enabled: Boolean(client), staleTime: 10_000,
    retry: (attempt: number, error: Error) => !(error instanceof LegalworkServerError && [401, 403].includes(error.status)) && attempt < 1,
  };
  return {
    assistant: { ...shared, queryKey: ["launcher-assistant", client?.baseUrl ?? ""], queryFn: async () => {
      if (!client) throw new Error("LegalWork is not connected.");
      return client.assistantConversationCurrent();
    } },
    workspaces: { ...shared, queryKey: ["launcher-workspaces", client?.baseUrl ?? ""], queryFn: async () => {
      if (!client) throw new Error("LegalWork is not connected.");
      const list = await client.listWorkspaces();
      return (list.items ?? list.workspaces ?? []).filter(workspace => workspace.preset !== "main-assistant" && workspace.preset !== "wiki");
    } },
  };
}
