import { useState } from "react";
import { changeListSelection } from "./list-selection";

/** Selections belong to the current list, never to hidden search/filter results. */
export function useListSelection(visible: string[], scope: string) {
  const [state, setState] = useState<{ scope: string; ids: string[]; anchor: string | null }>({ scope, ids: [], anchor: null });
  if (state.scope !== scope) setState({ scope, ids: [], anchor: null });
  const ids = state.scope === scope ? state.ids.filter(id => visible.includes(id)) : [];
  if (state.scope === scope && ids.length !== state.ids.length) setState({ ...state, ids });
  return {
    ids,
    toggle(id: string, range = false, order = visible) {
      setState(current => ({ scope, ...changeListSelection(current.scope === scope ? current.ids : [], order, current.anchor, id, range) }));
    },
    all() { setState({ scope, ids: visible, anchor: visible[0] ?? null }); },
    add(ids: string[]) { setState(current => ({ scope, ids: [...new Set([...current.ids.filter(id => visible.includes(id)), ...ids])], anchor: current.anchor })); },
    clear() { setState({ scope, ids: [], anchor: null }); },
  };
}
