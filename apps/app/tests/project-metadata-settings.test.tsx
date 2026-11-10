import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectMetadata } from "../src/react-app/domains/workspace/project-metadata";
import { t } from "../src/i18n";

for (const isTemplate of [false, true]) {
  test(`${isTemplate ? "Template" : "Project"} settings configure fields without showing record or value pickers`, () => {
    const cache = new QueryClient();
    const html = renderToStaticMarkup(<QueryClientProvider client={cache}><ProjectMetadata details={{ fields: [
      { id: "clients", label: "Clients", type: "backoffice", objectId: "clients", multiple: true,
        value: { directoryId: "local:fixture", recordIds: ["11111111-1111-4111-8111-111111111111"] } },
      { id: "notes", label: "Notes", type: "text", value: "Project-specific note" },
    ] }} isTemplate={isTemplate} onSave={async () => {}} onCancel={() => {}} /></QueryClientProvider>);
    expect(html).toContain(t("projects.field_name"));
    expect(html).toContain(t("projects.field_type"));
    expect(html).toContain(t("projects.reference.multiple"));
    expect(html).not.toContain('aria-label="Edit Clients"');
    expect(html).not.toContain('aria-label="Content"');
    expect(html).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(html).not.toContain("Project-specific note");
    cache.clear();
  });
}
