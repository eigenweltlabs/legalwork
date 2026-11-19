import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";

const states = new WeakMap<ServerConfig, { controller: AbortController; signingOut: boolean; uploadSignal?: AbortSignal }>();

function stateOf(config: ServerConfig) {
  let state = states.get(config);
  if (!state) {
    state = { controller: new AbortController(), signingOut: false };
    states.set(config, state);
  }
  return state;
}

export const syncDownloadSignal = (config: ServerConfig) => stateOf(config).controller.signal;
export const isSigningOut = (config: ServerConfig) => stateOf(config).signingOut;
export const syncUploadSignal = (config: ServerConfig) => stateOf(config).uploadSignal ?? AbortSignal.timeout(120_000);

/** Stop background downloads before uploading/checking and removing local copies. */
export async function withSignOutSync<T>(config: ServerConfig, action: () => Promise<T>): Promise<T> {
  const state = stateOf(config);
  if (state.signingOut) throw new ApiError(409, "account_transition", "Sign-out is already in progress.");
  state.signingOut = true;
  state.uploadSignal = AbortSignal.timeout(120_000);
  state.controller.abort();
  try { return await action(); }
  finally {
    state.controller = new AbortController();
    state.signingOut = false;
    delete state.uploadSignal;
  }
}
