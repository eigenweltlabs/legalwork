import { describe, expect, test } from "bun:test";
import { resolveConnectorUrl } from "@/react-app/domains/connections/modals/mcp-connector-setup-modal";

describe("resolveConnectorUrl", () => {
  test("defaults a scheme-less on-prem template to https", () => {
    expect(resolveConnectorUrl("{appliance}/mcp/", { appliance: "ki.firm.com" })).toBe(
      "https://ki.firm.com/mcp/",
    );
  });

  test("keeps a host:port appliance address intact", () => {
    expect(resolveConnectorUrl("{appliance}/mcp/", { appliance: "ki.firm.internal:8443" })).toBe(
      "https://ki.firm.internal:8443/mcp/",
    );
  });

  test("honors an explicit http:// appliance behind an internal proxy", () => {
    expect(resolveConnectorUrl("{appliance}/mcp/", { appliance: "http://127.0.0.1:8000" })).toBe(
      "http://127.0.0.1:8000/mcp/",
    );
  });

  test("does not double up a pasted trailing slash against the template path", () => {
    expect(resolveConnectorUrl("{appliance}/mcp/", { appliance: "https://ki.firm.com/" })).toBe(
      "https://ki.firm.com/mcp/",
    );
  });

  test("leaves vendor templates that hardcode their own scheme alone", () => {
    expect(resolveConnectorUrl("https://{instance}.highq.com/api/mcp", { instance: "acme" })).toBe(
      "https://acme.highq.com/api/mcp",
    );
  });

  test("leaves unfilled placeholders in place so submit can reject them", () => {
    expect(resolveConnectorUrl("{appliance}/mcp/", {})).toBe("https:///mcp/");
    expect(resolveConnectorUrl("https://{instance}.highq.com/api/mcp", {})).toBe(
      "https://.highq.com/api/mcp",
    );
  });
});
