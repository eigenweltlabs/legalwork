import { useQuery } from "@tanstack/react-query";
import type { ViewOwner } from "@legalwork/types/views";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { sameViewOwner } from "./view-save";

type ViewSaveDestination = { owner: ViewOwner; name: string };

export function useViewSaveDestinations(client: LegalworkServerClient) {
  return useQuery({ queryKey: ["view-save-destinations", client.baseUrl], queryFn: async () => {
    const [projects, wikis] = await Promise.all([client.listWorkspaces(), client.listWikis()]);
    return [
      ...projects.items.filter(project => !wikis.items.some(wiki => wiki.workspaceId === project.id))
        .map(project => ({ owner: { kind: "workspace", id: project.id } satisfies ViewOwner, name: project.displayName || project.name })),
      ...wikis.items.filter(wiki => wiki.writable).map(wiki => ({ owner: { kind: "wiki", id: wiki.id } satisfies ViewOwner, name: wiki.name })),
    ];
  } });
}

export function viewSaveDestinationGroups(destinations: ViewSaveDestination[] = [], origin?: ViewOwner, search = "", kind?: ViewOwner["kind"]) {
  const words = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const kinds: ViewOwner["kind"][] = origin?.kind === "wiki" ? ["wiki", "workspace"] : ["workspace", "wiki"];
  return kinds.filter(value => !kind || value === kind).map(kind => ({
    kind,
    label: t(kind === "wiki" ? "views.wikis" : "projects.plural"),
    items: destinations.filter(item => item.owner.kind === kind && words.every(word => item.name.toLocaleLowerCase().includes(word)))
      .sort((a, b) => Number(Boolean(origin && sameViewOwner(b.owner, origin))) - Number(Boolean(origin && sameViewOwner(a.owner, origin))) || a.name.localeCompare(b.name, undefined, { numeric: true })),
  })).filter(group => group.items.length > 0);
}
