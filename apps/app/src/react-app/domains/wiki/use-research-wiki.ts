import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";

/** Runs for existing users as well as onboarding, independently of database setup. */
export function useResearchWiki(client: LegalworkServerClient | null, owner: boolean, refreshWorkspaces: () => unknown, country?: string) {
  const language = useLocale() === "de" ? "de" : "en";
  const cache = useQueryClient();
  const setup = useQuery({
    queryKey: ["legal-research-wiki", client?.baseUrl, owner, language, country],
    enabled: Boolean(client && owner), staleTime: Infinity,
    queryFn: async () => {
      if (!client) throw new Error("LegalWork is not connected.");
      const result = await client.ensureLegalResearchWiki(language, country);
      if (result.wiki) {
        await cache.invalidateQueries({ queryKey: ["wikis", client.baseUrl] });
        await refreshWorkspaces();
      }
      return result;
    },
    retry: (count, error) => count < 2 && !(error instanceof LegalworkServerError && error.status < 500),
  });
  useEffect(() => {
    if (!setup.isError || setup.error instanceof LegalworkServerError && setup.error.status === 403) return;
    toast.error(t("research.wiki_setup_failed"), { id: "legal-research-wiki-setup", action: { label: t("wiki.retry"), onClick: () => { void setup.refetch(); } } });
  }, [setup.isError, setup.error, setup.refetch]);
}
