import { create } from "zustand";

/**
 * "An MCP sign-in is in flight" — the one signal the reload coordinator needs
 * from the connections domain.
 *
 * The engine keeps a sign-in's OAuth client registration in the workspace
 * instance that started it. Disposing that instance while the user is still
 * in the browser (the auto-reload after a connector is saved did exactly
 * this) leaves the callback to a rebuilt instance holding a different
 * registration, and the provider rejects the code exchange with "the client
 * ID does not match the authorize request". So no engine rebuild starts
 * while an attempt is active; the reload runs once sign-in ends.
 */
type McpSignInActivityStore = {
  /** Attempts currently preparing, waiting for the browser, or exchanging a code. */
  active: number;
  /** Mark an attempt active; the returned function marks it over. */
  begin: () => () => void;
};

export const useMcpSignInActivityStore = create<McpSignInActivityStore>((set) => ({
  active: 0,
  begin: () => {
    set((state) => ({ active: state.active + 1 }));
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      set((state) => ({ active: Math.max(0, state.active - 1) }));
    };
  },
}));
