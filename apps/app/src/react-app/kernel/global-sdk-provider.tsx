import {invalidateNativeCatalogReady} from "@/app/lib/opencode-catalog-ready";
/** @jsxImportSource react */
import {
  createContext,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { OpenCode, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client";

import { usePlatform } from "./platform";
import { useServer } from "./server-provider";

type OpencodeClient = OpenCodeClient;

type Listener = (payload: OpenCodeEvent) => void;

export type GlobalEventEmitter = {
  on: (channel: string, listener: Listener) => () => void;
  off: (channel: string, listener: Listener) => void;
  emit: (channel: string, payload: OpenCodeEvent) => void;
};

function createEmitter(): GlobalEventEmitter {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on(channel, listener) {
      let bucket = listeners.get(channel);
      if (!bucket) {
        bucket = new Set();
        listeners.set(channel, bucket);
      }
      bucket.add(listener);
      return () => this.off(channel, listener);
    },
    off(channel, listener) {
      const bucket = listeners.get(channel);
      if (!bucket) return;
      bucket.delete(listener);
      if (bucket.size === 0) listeners.delete(channel);
    },
    emit(channel, payload) {
      const bucket = listeners.get(channel);
      if (!bucket) return;
      for (const listener of bucket) listener(payload);
    },
  };
}

type GlobalSDKContextValue = {
  url: string;
  client: OpencodeClient;
  event: GlobalEventEmitter;
};

const GlobalSDKContext = createContext<GlobalSDKContextValue | undefined>(
  undefined,
);

function readLegalworkToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return (window.localStorage.getItem("legalwork.server.token") ?? "").trim();
  } catch {
    return "";
  }
}

type GlobalSDKProviderProps = {
  children: ReactNode;
};

export function GlobalSDKProvider({ children }: GlobalSDKProviderProps) {
  const server = useServer();
  const platform = usePlatform();
  const emitterRef = useRef<GlobalEventEmitter | null>(null);
  if (!emitterRef.current) {
    emitterRef.current = createEmitter();
  }
  const emitter = emitterRef.current;

  const token = readLegalworkToken();
  const headers =
    token && server.url.includes("/opencode")
      ? { Authorization: `Bearer ${token}` }
      : undefined;

  const [client, setClient] = useState<OpencodeClient>(() =>
    OpenCode.make({
      baseUrl: server.url,
      headers,
      fetch: platform.fetch,
    }),
  );

  useEffect(() => {
    setClient(
      OpenCode.make({
        baseUrl: server.url,
        headers,
        fetch: platform.fetch,
        }),
    );
  }, [platform.fetch, server.url]);

  useEffect(() => {
    const baseUrl = server.url;
    const isHealthy = server.healthy === true;
    if (!baseUrl || !isHealthy) return;

    const abort = new AbortController();
    const eventClient=OpenCode.make({baseUrl,headers,fetch:platform.fetch});
    let retry:ReturnType<typeof setTimeout>|undefined;
    let delay=1_000;
    const connect=async()=> {
      try {
        for await(const payload of eventClient.event.subscribe({signal:abort.signal})) {
          if(abort.signal.aborted)return;
          delay=1_000;
          if(["server.connected","model.updated","provider.updated","integration.updated","credential.updated","credential.switched","models-dev.refreshed","config.updated"].includes(payload.type))invalidateNativeCatalogReady();
          emitter.emit(payload.location?.directory ?? "global",payload);
          // Global readiness/catalog consumers must reconcile after every reconnect.
          if(payload.type==="server.connected" && payload.location?.directory)emitter.emit("global",payload);
        }
      } catch(error) {if(abort.signal.aborted)return;console.warn("OpenCode event stream disconnected",error);}
      if(!abort.signal.aborted) {retry=setTimeout(()=>void connect(),delay);delay=Math.min(delay*2,10_000);}
    };
    void connect();
    return ()=>{abort.abort();if(retry)clearTimeout(retry);};
    // headers is re-derived from local storage; rerun only when server URL or health flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emitter, platform.fetch, server.healthy, server.url]);

  const value = useMemo<GlobalSDKContextValue>(
    () => ({
      url: server.url,
      client,
      event: emitter,
    }),
    [client, emitter, server.url],
  );

  return (
    <GlobalSDKContext.Provider value={value}>{children}</GlobalSDKContext.Provider>
  );
}

export function useGlobalSDK(): GlobalSDKContextValue {
  const context = use(GlobalSDKContext);
  if (!context) {
    throw new Error("Global SDK context is missing");
  }
  return context;
}
