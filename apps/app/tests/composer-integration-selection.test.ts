import { expect, test } from "bun:test";
import { queuedDraftSchema } from "@legalwork/types/session-queue";
import { storageInputSchema } from "@legalwork/types/file-storage";
import { connectorStatusSchema } from "@legalwork/types/connectors";
import { createIntegrationMention, parseIntegrationMention, type IntegrationSelection } from "../src/react-app/domains/session/surface/composer/integration-mention";
import { buildComposerDraft } from "../src/react-app/domains/session/surface/composer/composer-draft";
import { encodeComposerMentionValue } from "../src/react-app/domains/session/surface/composer/mention-encoding";
import { installedConnections } from "../src/react-app/domains/session/surface/composer/installed-connections";
import { integrationMessageMetadata, splitIntegrationMessage } from "../src/react-app/domains/session/surface/composer/integration-message";
import { nativePrompt, systemReminderPart } from "../src/app/lib/system-reminder";

const kinds: IntegrationSelection["kind"][] = ["mcp", "account", "storage", "website"];
for (const kind of kinds) test(`${kind} chip preserves identity through draft restoration, sending and durable queue editing`, () => {
  const selection = { kind, id: "connection /%:id", label: "My files & research [DE] @work" };
  const value = createIntegrationMention(selection);
  expect(parseIntegrationMention(value)).toEqual(selection);
  const text = `Please use @${encodeComposerMentionValue(value)} for this request`;
  const draft = buildComposerDraft(text, [], {}, []);
  expect(draft.resolvedText).toBe(`Please use @${selection.label} for this request`);
  expect(draft.modelContext).toContain(JSON.stringify(selection));
  expect(draft.modelContext).not.toContain("legalwork-integration://");
  expect(draft.parts).toEqual([{ type: "text", text: draft.resolvedText }]);
  const stored = queuedDraftSchema.parse({ ...draft, editor: { mentions: { [value]: "integration" }, pasteParts: [] } });
  const sent = nativePrompt({ sessionID: "chat", parts: [{ type: "text", text: draft.resolvedText ?? "" }, systemReminderPart(draft.modelContext ?? "")], draft: stored });
  expect(sent.metadata.legalworkPrompt.visibleText).toBe(draft.resolvedText);
  expect(integrationMessageMetadata(sent.metadata.legalworkPrompt).integrations).toEqual([selection]);
  expect(buildComposerDraft(stored.text, [], stored.editor.mentions, []).modelContext).toBe(draft.modelContext);
  expect(buildComposerDraft(`/review @${encodeComposerMentionValue(value)}`, [], {}, []).command).toBeUndefined();
  expect(buildComposerDraft("/review file", [], { [value]: "integration" }, []).command?.name).toBe("review");
});

test("integration chips keep inline spacing and deliberate line breaks without styling unrelated @text", () => {
  const reference: IntegrationSelection = { kind: "website", id: "beck", label: "beck-online" };
  expect(splitIntegrationMessage("@beck-online open", [reference])).toEqual(["", reference, " open"]);
  expect(splitIntegrationMessage("@beck-online\n\nNeue Zeile", [reference])).toEqual(["", reference, "\n\nNeue Zeile"]);
  expect(splitIntegrationMessage("@beck-online-extra and email@beck-online", [reference])).toEqual(["@beck-online-extra and email@beck-online"]);
  expect(splitIntegrationMessage("@beck-online open", [])).toEqual(["@beck-online open"]);
  const legacy = integrationMessageMetadata({ reminders: [systemReminderPart(buildComposerDraft(`@${encodeComposerMentionValue(createIntegrationMention(reference))}`, [], {}, []).modelContext ?? "").text] });
  expect(legacy).toEqual({ integrations: [reference], legacyIntegrationSpacing: true });
  expect(splitIntegrationMessage("Use \n@beck-online\n open", legacy.integrations, legacy.legacyIntegrationSpacing)).toEqual(["Use ", reference, " open"]);
});

test("invalid integration references cannot become hidden instructions", () => {
  for (const token of ["legalwork-integration://mcp/%zz?name=x", "legalwork-integration://file/id?name=x", "legalwork-integration://storage/?name=x"]) {
    expect(parseIntegrationMention(token)).toBeNull();
    expect(buildComposerDraft(`@${token}`, [], {}, []).modelContext).toBeUndefined();
  }
});

test("installed accounts, named storage and website logins are all offered without secrets or duplicate native roots", () => {
  const accounts = connectorStatusSchema.parse({ configured: true, requiresSignIn: false, connectors: [{ id: "gmail", name: "Gmail", configured: true, connections: [{ id: "a", createdAt: null, needsReconnect: false }] }] });
  const storage = { ...storageInputSchema.parse({ name: "My records", config: { kind: "s3", bucket: "secret-bucket", region: "eu-central-1" } }), id: "s3", updatedAt: 1, configuredSecrets: ["secretAccessKey"] };
  const items = installedConnections(accounts, [storage, { ...storage, id: "firm", name: "Firm records", team: { orgId: "org", version: 1, installed: true } }, { ...storage, id: "uninstalled", team: { orgId: "org", version: 1, installed: false } }, { ...storage, id: "connector:gmail" }], [{ id: "login", label: "beck-online", username: "private-user", origin: "https://beck-online.beck.de", updatedAt: "today", websites: [{ name: "beck-online", url: "https://beck-online.beck.de" }] }]);
  expect(items.map(item => item.selection.id).sort()).toEqual(["firm", "gmail", "login", "s3"]);
  expect(items.find(item => item.selection.id === "firm")?.firm).toBe(true);
  for (const secret of ["secret-bucket", "private-user", "secretAccessKey"]) expect(JSON.stringify(items)).not.toContain(secret);
});
