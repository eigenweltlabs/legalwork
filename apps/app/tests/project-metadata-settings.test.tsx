import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectMetadata } from "../src/react-app/domains/workspace/project-metadata";
import { t } from "../src/i18n";

test("Template field settings edit definitions without selecting project values", () => {
  const cache = new QueryClient();
  const html = renderToStaticMarkup(<QueryClientProvider client={cache}><ProjectMetadata details={{ fields: [
    { id: "clients", label: "Clients", type: "backoffice", objectId: "clients", multiple: true,
      value: { directoryId: "local:fixture", recordIds: ["11111111-1111-4111-8111-111111111111"] } },
    { id: "notes", label: "Notes", type: "text", value: "Only editable on Project Home" },
  ] }} definitionsOnly onSave={async () => {}} onCancel={() => {}} /></QueryClientProvider>);
  expect(html).toContain("Allow multiple records");
  expect(html).toContain("Field type");
  expect(html).not.toContain("Search Clients");
  expect(html).not.toContain("Edit Clients");
  expect(html).not.toContain("11111111-1111-4111-8111-111111111111");
  expect(html).not.toContain("Only editable on Project Home");
  cache.clear();
});

test("Project field settings include content alongside name and type", () => {
  const cache = new QueryClient();
  const html = renderToStaticMarkup(<QueryClientProvider client={cache}><ProjectMetadata details={{ fields: [
    { id: "notes", label: "Notes", labelSource: "custom", type: "text", value: "Editable in field settings" },
  ] }} showTemplates={false} onSave={async () => {}} onCancel={() => {}} /></QueryClientProvider>);
  expect(html).toContain(`aria-label="${t("projects.field_name")}"`);
  expect(html).toContain(`aria-label="${t("projects.field_type")}"`);
  expect(html).toContain(`aria-label="${t("projects.field_value")}"`);
  expect(html).toContain("Editable in field settings");
  cache.clear();
});
