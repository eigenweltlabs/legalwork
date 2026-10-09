import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingPermission } from "../src/app/types";

import {
  PermissionApprovalPanel,
  permissionDetailRows,
} from "../src/react-app/domains/session/chat/permission-approval-modal";

function pendingPermission(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    id: "permission-1",
    sessionID: "session-1",
    permission: "bash",
    patterns: ["rm -rf dist"],
    metadata: {},
    always: {
      session: false,
      project: false,
    },
    receivedAt: 1,
    protocol: "legacy",
    ...overrides,
  };
}

describe("permission approval modal helpers", () => {
  test("network approval uses the inline chat panel with task, destination and one-time choices", () => {
    const html = renderToStaticMarkup(React.createElement(PermissionApprovalPanel, {
      permission: pendingPermission({ permission: "webfetch", protocol: "host", host: {
        id: "request-1", workspaceId: "matter", sessionID: "session-1", action: "sandbox.webfetch", summary: "POST example.com",
        description: "Submit the sample document", paths: [], createdAt: 1, actor: { type: "host" },
        network: { method: "POST", url: "https://example.com/upload", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "document=Sample+document", bodyBytes: 24, bodyFormat: "text" },
      } }), respondPermission: () => {},
    }));
    expect(html).toContain("Send information?");
    expect(html).toContain("Submit the sample document");
    expect(html).toContain("example.com");
    expect(html).toContain("document: Sample document");
    expect(html).not.toContain('role="dialog"');
    const buttons = Array.from(html.matchAll(/<button\b[\s\S]*?<\/button>/g)).map((match) => match[0].replace(/<[^>]*>/g, "").trim());
    expect(buttons).toEqual(["Deny", "Allow once"]);
  });
  test("surfaces risk-bearing metadata as review rows", () => {
    expect(
      permissionDetailRows({
        command: "rm -rf dist",
        description: "Remove build output",
        cwd: "/workspace/project",
        filepath: "/workspace/project/src/app.ts",
        diff: "-old\n+new",
        output: "not shown before approval",
      }).map((row) => [row.label, row.value]),
    ).toEqual([
      ["Command", "rm -rf dist"],
      ["Description", "Remove build output"],
      ["Working directory", "/workspace/project"],
      ["File", "/workspace/project/src/app.ts"],
      ["Diff", "-old\n+new"],
    ]);
  });

  test("deduplicates alternate file metadata keys", () => {
    expect(
      permissionDetailRows({
        filepath: "/workspace/project/a.ts",
        filePath: "/workspace/project/b.ts",
      }).map((row) => [row.label, row.value]),
    ).toEqual([["File", "/workspace/project/a.ts"]]);
  });

  test("summarizes apply-patch file metadata", () => {
    expect(
      permissionDetailRows({
        files: [
          { type: "add", relativePath: "src/new.ts" },
          { type: "delete", filePath: "/workspace/project/src/old.ts" },
          { type: "", path: "src/update.ts" },
        ],
      }).map((row) => [row.label, row.value]),
    ).toEqual([
      ["Files", "add: src/new.ts\ndelete: /workspace/project/src/old.ts\nchange: src/update.ts"],
    ]);
  });

  test("keeps keyboard order on the safer one-shot approval before session approval", () => {
    const html = renderToStaticMarkup(
      React.createElement(PermissionApprovalPanel, {
        permission: pendingPermission(),
        respondPermission: () => {},
      }),
    );

    const buttonLabels = Array.from(html.matchAll(/<button\b[\s\S]*?<\/button>/g)).map((match) =>
      match[0].replace(/<[^>]*>/g, "").trim(),
    );

    expect(buttonLabels).toEqual(["Deny", "Allow once", "Allow for session"]);
  });

  test("uses readable labels for generic permission titles", () => {
    const html = renderToStaticMarkup(
      React.createElement(PermissionApprovalPanel, {
        permission: pendingPermission({ permission: "todowrite" }),
        respondPermission: () => {},
      }),
    );

    expect(html).toContain("Approve Todo write?");
    expect(html).not.toContain("Approve todowrite?");
  });

  test("project instruction approval shows both texts and only permits a single change", () => {
    const render = (proposedInstructions: string) => renderToStaticMarkup(React.createElement(PermissionApprovalPanel, {
      permission: pendingPermission({
        permission: "legalwork_project_set_instructions", patterns: ["/workspace/matter"], always: [],
        metadata: { previousInstructions: "Formal English", proposedInstructions },
      }),
      respondPermission: () => {},
    }));
    const html = render("Use short paragraphs. <script>alert('test')</script>");
    expect(html).toContain("Update project instructions?");
    expect(html).toContain("Current instructions");
    expect(html).toContain("Formal English");
    expect(html).toContain("Proposed instructions");
    expect(html).toContain("Use short paragraphs.");
    expect(html).not.toContain("<script>");
    const labels = Array.from(html.matchAll(/<button\b[\s\S]*?<\/button>/g)).map(match => match[0].replace(/<[^>]*>/g, "").trim());
    expect(labels).toEqual(["Deny", "Allow once"]);
    expect(html).not.toContain("Approval applies to this change only.");
    expect(render("")).toContain("Use global defaults");
  });
});
