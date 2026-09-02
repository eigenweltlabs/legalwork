import { afterEach, describe, expect, test } from "bun:test";

import type { LegalworkServerClient } from "../src/app/lib/legalwork-server";
import type { LegalworkServerStore } from "../src/react-app/domains/connections/legalwork-server-store";

type DesktopCall = { command: string; args: unknown[] };

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, "window", originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("desktop MCP removal", () => {
  test("also removes the LegalWork server runtime entry", async () => {
    const desktopCalls: DesktopCall[] = [];
    const browserWindow = new EventTarget() as EventTarget & {
      __LEGALWORK_ELECTRON__?: {
        invokeDesktop: (command: string, ...args: unknown[]) => Promise<unknown>;
      };
    };
    browserWindow.__LEGALWORK_ELECTRON__ = {
      invokeDesktop: async (command, ...args) => {
        desktopCalls.push({ command, args });
        if (command === "readOpencodeConfig") {
          return { path: "/tmp/opencode.jsonc", exists: false, content: null };
        }
        if (command === "mergeRuntimeMcpServer") {
          return { ok: true, status: 0, stdout: "removed", stderr: "" };
        }
        throw new Error(`Unexpected desktop command: ${command}`);
      },
    };
    Object.defineProperty(globalThis, "window", {
      value: browserWindow,
      configurable: true,
    });

    const serverCalls: Array<{ workspaceId: string; name: string }> = [];
    const legalworkClient = {
      removeMcp: async (workspaceId: string, name: string) => {
        serverCalls.push({ workspaceId, name });
        return { items: [] };
      },
    } as unknown as LegalworkServerClient;
    const legalworkServer = {
      getSnapshot: () => ({
        legalworkServerStatus: "connected",
        legalworkServerClient: legalworkClient,
        legalworkServerCapabilities: { mcp: { read: true, write: true } },
      }),
    } as unknown as LegalworkServerStore;

    const { createConnectionsStore } = await import("../src/react-app/domains/connections/store");
    const { getReactQueryClient } = await import("../src/react-app/infra/query-client");
    const queryClient = getReactQueryClient();
    queryClient.setQueryData(["legalmemory-tree-roots", "ws-runtime"], {
      roots: [{ source_id: "stale-drive-root" }],
    });
    const store = createConnectionsStore({
      client: () => null,
      setClient: () => undefined,
      projectDir: () => "/tmp/project",
      selectedWorkspaceId: () => "ws-local",
      selectedWorkspaceRoot: () => "/tmp/project",
      workspaceType: () => "local",
      legalworkServer,
      runtimeWorkspaceId: () => "ws-runtime",
      developerMode: () => false,
    });

    let connectionChanges = 0;
    browserWindow.addEventListener("legalwork:legalmemory-connection-changed", () => {
      connectionChanges += 1;
    });

    await store.removeMcp("legalmemory");

    expect(serverCalls).toEqual([{ workspaceId: "ws-runtime", name: "legalmemory" }]);
    expect(desktopCalls).toContainEqual({
      command: "mergeRuntimeMcpServer",
      args: ["legalmemory", null],
    });
    expect(queryClient.getQueryData(["legalmemory-tree-roots", "ws-runtime"])).toBeUndefined();
    expect(connectionChanges).toBe(1);
  });
});
