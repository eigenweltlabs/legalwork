import { expect, spyOn, test } from "bun:test";
import { LegalWorkExtensionsPreview } from "./legalwork-extensions-preview.js";
import { nativePluginTestRuntime } from "./native-plugin-test-support.js";

test("native browser extensions register offline with truthful structured results", async () => {
  const network = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Plugin registration must stay offline"));
  const runtime = nativePluginTestRuntime();
  try {
    await runtime.start(LegalWorkExtensionsPreview);
    for (const name of ["legalwork_browser_open_url", "legalwork_browser_connect", "legalwork_browser_upload", "legalwork_browser_capture", "legalwork_browser_batch", "legalwork_browser_downloads", "legalwork_browser_passwords", "legalwork_browser_fill_password", "legalwork_browser_request_password"]) {
      const tool = runtime.tools.get(name);
      expect(tool).toBeDefined();
      expect(tool?.input).toBeDefined();
      expect(tool?.output).toBeDefined();
    }
    expect(runtime.tools.has("browser_version")).toBe(false);
    expect(network).not.toHaveBeenCalled();
  } finally { await runtime.close(); network.mockRestore(); }
});
