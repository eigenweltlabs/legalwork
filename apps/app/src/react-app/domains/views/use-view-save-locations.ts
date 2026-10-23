import { useQuery } from "@tanstack/react-query";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { savedViewKey, useViewCopyStore, verifyViewCopies, viewCopyCandidates, type ViewSaveScope } from "./view-save-locations";

export function useViewSaveLocations(client: LegalworkServerClient, scope: ViewSaveScope) {
  const groups = useViewCopyStore(state => state.groups);
  const candidates = viewCopyCandidates(groups, client.baseUrl, scope);
  return useQuery({
    queryKey: ["view-save-locations", client.baseUrl, scope.key, candidates.map(view => savedViewKey(client.baseUrl, view))],
    queryFn: () => verifyViewCopies(client, candidates),
    retry: false,
    refetchInterval: 15_000,
  });
}
