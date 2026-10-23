import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { ViewRecordSchema, type ViewSummary } from "@legalwork/types/views";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";

const summarySchema = ViewRecordSchema.pick({ id: true, title: true, mode: true, updatedAt: true, revision: true, owner: true }).strip();
type SaveGroup = { keys: string[]; views: ViewSummary[] };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export type ViewSaveScope = { key: string; existing?: ViewSummary };

export function savedViewKey(serverUrl: string, view: ViewSummary) {
  return JSON.stringify([serverUrl, view.owner.kind, view.owner.id, view.id, view.revision]);
}

/** UI receipts only: copies remain independent files. Verify each reference before displaying it. */
export function rememberViewCopy(groups: SaveGroup[], serverUrl: string, scope: ViewSaveScope, view: ViewSummary): SaveGroup[] {
  const previous = groups.find(group => group.keys.includes(scope.key));
  const views = [...(previous?.views ?? []), ...(scope.existing ? [scope.existing] : []), summarySchema.parse(view)];
  const unique = [...new Map(views.map(item => [savedViewKey(serverUrl, item), summarySchema.parse(item)])).values()].slice(-100);
  const keys = [...new Set([scope.key, ...(previous?.keys ?? []), ...unique.map(item => savedViewKey(serverUrl, item))])].slice(-201);
  return [...groups.filter(group => group !== previous), { keys, views: unique }].slice(-200);
}

export function createViewCopyStore(storage: () => StateStorage = () => localStorage) {
  return create<{ groups: SaveGroup[]; remember: (serverUrl: string, scope: ViewSaveScope, view: ViewSummary) => void }>()(persist(set => ({
    groups: [],
    remember: (serverUrl, scope, view) => {
      try { set(state => ({ groups: rememberViewCopy(state.groups, serverUrl, scope, view) })); }
      catch { /* A full local cache must not turn a successful file save into an error. */ }
    },
  }), {
    name: "legalwork.view-copy-locations",
    storage: createJSONStorage(storage),
    partialize: state => ({ groups: state.groups }),
    merge: (stored, current) => {
      if (!record(stored) || !Array.isArray(stored.groups)) return current;
      const groups = stored.groups.slice(-200).flatMap((group: unknown) => {
        if (!record(group) || !Array.isArray(group.keys) || group.keys.length > 201) return [];
        const keys = group.keys.filter((key: unknown): key is string => typeof key === "string");
        const views = summarySchema.array().max(100).safeParse(group.views);
        return views.success ? [{ keys, views: views.data }] : [];
      });
      return { ...current, groups };
    },
  }));
}
export const useViewCopyStore = createViewCopyStore();

export function viewCopyCandidates(groups: SaveGroup[], serverUrl: string, scope: ViewSaveScope) {
  const views = [...(groups.find(group => group.keys.includes(scope.key))?.views ?? []), ...(scope.existing ? [scope.existing] : [])];
  return [...new Map(views.map(view => [savedViewKey(serverUrl, view), view])).values()];
}

export async function verifyViewCopies(client: Pick<LegalworkServerClient, "readView">, candidates: ViewSummary[]) {
  return (await Promise.all(candidates.map(async candidate => {
    try {
      const view = await client.readView(candidate.owner, candidate.id);
      return view.revision === candidate.revision ? [summarySchema.parse(view)] : [];
    } catch (error) {
      if (error instanceof LegalworkServerError && [403, 404].includes(error.status)) return [];
      throw error;
    }
  }))).flat();
}
