import { describe, expect, test } from "bun:test";

import type { McpDirectoryInfo } from "../src/app/constants";
import { buildExtensionItems } from "../src/react-app/domains/settings/extension-items";

const connectedBuiltIn: McpDirectoryInfo = {
  id: "legalwork-browser",
  name: "LegalWork Browser",
  serverName: "legalwork-browser",
  description: "Connected by default.",
  oauth: false,
  kind: "extension",
  extensionManifest: {
    schemaVersion: 1,
    id: "legalwork-browser",
    name: "LegalWork Browser",
    description: "Connected by default.",
    source: { format: "legalwork-builtin", origin: "builtin", trusted: true },
    resources: [],
  },
};

const availableBuiltIn: McpDirectoryInfo = {
  id: "computer-use",
  name: "Computer Use",
  serverName: "computer-use",
  description: "Marketplace-only until installed.",
  oauth: false,
  kind: "extension",
  extensionManifest: {
    schemaVersion: 1,
    id: "computer-use",
    name: "Computer Use",
    description: "Marketplace-only until installed.",
    source: { format: "legalwork-builtin", origin: "builtin", trusted: true },
    resources: [],
    platform: ["darwin"],
  },
};

describe("extension item projection", () => {
  test("keeps unconnected built-ins out of My Extensions quick connect", () => {
    const result = buildExtensionItems({
      quickConnect: [connectedBuiltIn, availableBuiltIn],
      platform: "darwin",
      mcpServers: [],
      installedSkills: [],
      enablementContext: {},
      isBuiltInConnected: (entry) => entry.id === connectedBuiltIn.id,
    });

    expect(result.installedMcpEntries.map((entry) => entry.name)).toEqual(["LegalWork Browser"]);
    expect(result.builtInItems.map((item) => item.name)).toEqual(["LegalWork Browser", "Computer Use"]);
    expect(result.quickConnectEntries.map((entry) => entry.name)).toEqual(["LegalWork Browser", "Computer Use"]);
  });

  test("omits macOS-only extensions from the Windows catalog", () => {
    const result = buildExtensionItems({
      quickConnect: [connectedBuiltIn, availableBuiltIn],
      platform: "windows",
      mcpServers: [],
      installedSkills: [],
      enablementContext: {},
      isBuiltInConnected: () => false,
    });

    expect(result.builtInItems.map((item) => item.name)).toEqual(["LegalWork Browser"]);
    expect(result.quickConnectEntries.map((entry) => entry.name)).toEqual(["LegalWork Browser"]);
  });
});
