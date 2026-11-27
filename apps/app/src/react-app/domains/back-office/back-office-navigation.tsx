import { createContext, useCallback, useContext, type ReactNode } from "react";
import { parsePath, useLocation, useNavigate, useSearchParams, type NavigateOptions } from "react-router-dom";
import { z } from "@legalwork/types/back-office";

export const defaultBackOfficePath = "/back-office/matters";

export function isBackOfficePath(path: string) {
  return /^\/back-office(?:\/(?:[A-Za-z][A-Za-z0-9_-]{0,99}|@tasks|@deadlines))?(?:\?[^#]*)?$/.test(path);
}

export const openBackOfficeArgs = z.object({
  objectId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/).optional(),
  viewId: z.string().uuid().optional(),
  recordId: z.string().uuid().optional(),
}).strict().refine(args => Boolean(args.objectId || (!args.viewId && !args.recordId)));

export function backOfficePathFor({ objectId, viewId, recordId }: z.infer<typeof openBackOfficeArgs>) {
  if (!objectId) return undefined;
  const query = new URLSearchParams();
  if (viewId) query.set("viewId", viewId);
  if (recordId) query.set("record", recordId);
  return "/back-office/" + objectId + (query.size ? "?" + query : "");
}

const BackOfficeTabNavigation = createContext<{ path: string; onNavigate: (path: string) => void } | null>(null);

export function BackOfficeTabNavigationProvider({ path = defaultBackOfficePath, onNavigate, children }: {
  path?: string;
  onNavigate: (path: string) => void;
  children: ReactNode;
}) {
  return <BackOfficeTabNavigation.Provider value={{ path, onNavigate }}>{children}</BackOfficeTabNavigation.Provider>;
}

export function useBackOfficeLocation() {
  const tab = useContext(BackOfficeTabNavigation);
  const location = useLocation();
  const path = tab && parsePath(tab.path);
  return path ? { pathname: path.pathname ?? defaultBackOfficePath, search: path.search ?? "" } : location;
}

export function useBackOfficeNavigate() {
  const tab = useContext(BackOfficeTabNavigation);
  const navigate = useNavigate();
  return useCallback((path: string) => {
    if (tab && isBackOfficePath(path)) tab.onNavigate(path);
    else navigate(path);
  }, [tab, navigate]);
}

export function useBackOfficeSearchParams() {
  const tab = useContext(BackOfficeTabNavigation);
  const [params, setParams] = useSearchParams();
  const location = tab && parsePath(tab.path);
  const search = location ? new URLSearchParams(location.search) : params;
  const setSearch = (update: (current: URLSearchParams) => URLSearchParams, options?: NavigateOptions) => {
    if (!location || !tab) { setParams(update, options); return; }
    const next = update(search).toString();
    tab.onNavigate((location.pathname ?? defaultBackOfficePath) + (next ? "?" + next : ""));
  };
  return [search, setSearch] as const;
}
