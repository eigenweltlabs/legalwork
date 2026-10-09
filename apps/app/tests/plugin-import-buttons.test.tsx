import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ExtensionsView, type ExtensionsViewProps } from "../src/react-app/domains/settings/pages/extensions-view";

const noop = () => {};
const props: ExtensionsViewProps = {
  busy: false, developerMode: false, selectedWorkspaceRoot: "/project", isRemoteWorkspace: false, canEditPlugins: true, canUseGlobalScope: true, suggestedPlugins: [], mcpConnectedAppsCount: 0, mcpView: <p>Connectors</p>, skillsView: <p>Skills</p>, onRefresh: noop,
  pluginImports: { discoverPluginImports: async () => [], previewPluginImports: async () => [], installPluginImport: async () => { throw new Error("not invoked"); } },
  extensions: { pluginScope: "project", setPluginScope: noop, refreshPlugins: noop, pluginConfigPath: () => null, pluginConfig: () => null, pluginList: () => [], pluginInput: () => "", setPluginInput: noop, pluginStatus: () => null, addPlugin: noop, removePlugin: noop, isPluginInstalledByName: () => false, activePluginGuide: () => null, setActivePluginGuide: noop },
};
test("plugin imports are available on Extensions without enabling developer mode", () => {
  const html = renderToStaticMarkup(<ExtensionsView {...props} />);
  expect(html).toContain("Import from ChatGPT"); expect(html).toContain("Import from Claude");
  expect(html).not.toContain("Engine plugins");
});
test("read-only clients keep visible but disabled import actions", () => {
  const html = renderToStaticMarkup(<ExtensionsView {...props} canEditPlugins={false} />);
  expect(html).toMatch(/<button[^>]+disabled[^>]*>Import from ChatGPT/);
  expect(html).toMatch(/<button[^>]+disabled[^>]*>Import from Claude/);
});
