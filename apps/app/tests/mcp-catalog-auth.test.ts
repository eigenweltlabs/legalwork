import { describe, expect, test } from "bun:test";

import { getMcpServerName, MCP_QUICK_CONNECT } from "../src/app/constants";

describe("MCP catalog authentication", () => {
  test("each server has one setup policy, so catalog lookup cannot select a conflicting entry", () => {
    const keys = MCP_QUICK_CONNECT.map((entry) => entry.id ?? getMcpServerName(entry));
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
    expect(duplicates).toEqual([]);
  });

  test("Dropbox collects its registered app credentials before trying to open OAuth", () => {
    const dropbox = MCP_QUICK_CONNECT.find((entry) => entry.serverName === "dropbox");
    expect(dropbox?.oauth).toBe(true);
    expect(dropbox?.requiresOauthClient).toBe(true);
    expect(dropbox?.requiresToken).not.toBe(true);
    expect(dropbox?.setupNote).toContain("app key");
    expect(dropbox?.setupUrl).toBe("https://help.dropbox.com/integrations/connect-dropbox-mcp-server");
    expect(dropbox?.description).not.toContain("One-click");
  });

  test("interactive CourtListener and Everlaw connectors use OAuth rather than token-only setup", () => {
    for (const name of ["courtlistener", "everlaw"]) {
      const entry = MCP_QUICK_CONNECT.find((entry) => entry.serverName === name);
      expect(entry?.oauth).toBe(true);
      expect(entry?.requiresToken).not.toBe(true);
    }
  });

  test("LegalMemory discovers auth requirements for its firm's deployment", () => {
    const entry = MCP_QUICK_CONNECT.find((item) => item.serverName === "legalmemory");
    expect(entry).toBeDefined();
    expect(entry?.oauth).toBeUndefined();
  });
});
