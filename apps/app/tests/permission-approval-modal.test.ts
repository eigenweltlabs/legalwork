import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingPermission } from "../src/app/types";
import type { PermissionRequest } from "@opencode/client";
import type { Part } from "../src/app/lib/opencode-view";
import { permissionToolInput, permissionWithReceivedAt } from "../src/react-app/domains/session/sync/interaction-state";

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
  test("folder approval explains chat scope and shows the native resolved destination", () => {
    const permission = permissionWithReceivedAt({
      id: "folder", sessionID: "session-1", action: "external_directory", resources: ["/shortcut/*"], save: ["/shortcut/*"],
      message: "This folder resolves to /actual/private. Remembering approval includes that destination.",
    } satisfies PermissionRequest, 1);
    const html = renderToStaticMarkup(React.createElement(PermissionApprovalPanel, { permission, respondPermission: () => {} }));
    const main = html.split("<details")[0];
    expect(main).toContain("/actual/private");
    expect(main).toContain("/shortcut/*");
    expect(main).toContain("Allow for this chat");
    expect(main).toContain("Other chats do not receive access");
    expect(main).not.toContain("Allow for project");
  });

  test("shows actual MCP call arguments before approving an engine event with empty metadata", () => {
    const request = permissionWithReceivedAt({
      id: "mcp-request", sessionID: "child-session", action: "legalmemory_search", resources: ["*"],
      metadata: {}, save: ["*"], source: { messageID: "message-one", id: "call-one" },
    } satisfies PermissionRequest, 1);
    const part: Part = {
      id: "part-one", sessionID: "child-session", messageID: "message-one", type: "tool", callID: "call-one", tool: "legalmemory_search",
      state: { status: "pending", input: { query: "Synthetic contract <terms>", filter: { matter_id: "matter-one" }, limit: 10 }, raw: "" },
    };
    const value = permissionToolInput(request, { info: { id: "message-one", sessionID: "child-session" }, parts: [part] });
    const html = renderToStaticMarkup(React.createElement(PermissionApprovalPanel, {
      permission: { ...request, toolInput: { status: "ready", value } }, respondPermission: () => {},
    }));
    const main = html.split("<details")[0];
    expect(main).toContain("Synthetic contract &lt;terms&gt;");
    expect(main).toContain("matter-one");
    expect(main).toContain("limit");
    expect(main).toContain("10");
    expect(main).not.toContain("Synthetic contract <terms>");
  });

  test("does not reuse arguments from another request, session, message, or completed call", () => {
    const request = permissionWithReceivedAt({
      id: "request", sessionID: "child", action: "legalmemory_search", resources: ["*"], metadata: {}, save: [],
      source: { messageID: "message", id: "call" },
    } satisfies PermissionRequest, 1);
    const part: Part = { id: "part", type: "tool", sessionID: "child", messageID: "message", callID: "call", tool: "legalmemory_search",
      state: { status: "running", input: { query: "Correct query" }, time: { start: 1 } } };
    const message = { info: { id: "message", sessionID: "child" }, parts: [part] };
    expect(permissionToolInput(request, message)).toEqual({ query: "Correct query" });
    expect(() => permissionToolInput(request, { ...message, info: { ...message.info, sessionID: "parent" } })).toThrow();
    expect(() => permissionToolInput(request, { ...message, info: { ...message.info, id: "previous-message" } })).toThrow();
    expect(() => permissionToolInput(request, { ...message, parts: [{ ...part, callID: "previous-call" }] })).toThrow();
    expect(() => permissionToolInput(request, { ...message, parts: [{ ...part, sessionID: "parent" }] })).toThrow();
    expect(() => permissionToolInput(request, { ...message, parts: [{ ...part, state: {
      status: "completed", input: { query: "Old query" }, output: "done", title: "Search", metadata: {}, time: { start: 1, end: 2 },
    } }] })).toThrow();
  });

  test("keeps denial available but blocks approval while tool arguments are loading or unavailable", () => {
    for (const status of ["loading", "unavailable"] satisfies Array<"loading" | "unavailable">) {
      const html = renderToStaticMarkup(React.createElement(PermissionApprovalPanel, {
        permission: pendingPermission({ permission: "legalmemory_search", toolInput: { status } }), respondPermission: () => {}, onRetryInput: () => {},
      }));
      const buttons = Array.from(html.matchAll(/<button\b[\s\S]*?<\/button>/g), match => match[0]);
      expect(buttons[0]).toContain("Deny");
      expect(buttons[0]).not.toMatch(/\sdisabled=/);
      expect(buttons[1]).toMatch(/\sdisabled=/);
      expect(buttons[2]).toMatch(/\sdisabled=/);
      expect(html).toContain(status === "loading" ? "Loading" : "could not be loaded");
      if (status === "unavailable") expect(html).toContain("Retry details");
    }
  });

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
    expect(html).toContain("Document</dt>");
    expect(html).toContain("Sample document</dd>");
    expect(html).not.toContain('role="dialog"');
    const buttons = Array.from(html.matchAll(/<button\b[\s\S]*?<\/button>/g)).map((match) => match[0].replace(/<[^>]*>/g, "").trim());
    expect(buttons).toEqual(["Deny", "Allow once"]);
  });
  test("search approval keeps the query prominent and raw JSON inside collapsed Details", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_exa", arguments: { query: "Miami weather <today>" } } });
    const network = { method: "POST", url: "https://mcp.exa.ai/mcp", headers: {}, body, bodyBytes: body.length, bodyFormat: "text" };
    const html = renderToStaticMarkup(React.createElement(PermissionApprovalPanel, {
      permission: pendingPermission({ permission: "webfetch", protocol: "host", metadata: { network }, host: {
        id: "request-1", workspaceId: "matter", sessionID: "session-1", action: "sandbox.webfetch", summary: "POST mcp.exa.ai",
        description: "Search the web for: Miami weather", paths: [], createdAt: 1, actor: { type: "host" }, network,
      } }), respondPermission: () => {},
    }));
    const main = html.split("<details")[0];
    expect(main).toContain("Search the web?");
    expect(main).toContain("Miami weather &lt;today&gt;");
    expect(main).toContain("Exa Search");
    expect(main).not.toContain("jsonrpc");
    expect(main).not.toContain("tools/call");
    expect(main).not.toContain("start an action");
    expect(main).not.toContain("Agent’s task");
    expect(html).toContain("jsonrpc");
    expect(html).not.toContain("<details open");
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

  test("keeps keyboard order on the safer one-shot approval before project approval", () => {
    const html = renderToStaticMarkup(
      React.createElement(PermissionApprovalPanel, {
        permission: pendingPermission(),
        respondPermission: () => {},
      }),
    );

    const buttonLabels = Array.from(html.matchAll(/<button\b[\s\S]*?<\/button>/g)).map((match) =>
      match[0].replace(/<[^>]*>/g, "").trim(),
    );

    expect(buttonLabels).toEqual(["Deny", "Allow once", "Allow for this chat"]);
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

  test("identifies the subagent and escapes its title without changing approval choices", () => {
    const html = renderToStaticMarkup(React.createElement(PermissionApprovalPanel, {
      permission: pendingPermission({ sourceSession: { id: "child", title: "Research <contract>" } }),
      onOpenSession: () => {},
      respondPermission: () => {},
    }));
    expect(html).toContain("Request from subagent: Research &lt;contract&gt;");
    expect(html).toContain("Open subagent chat");
    expect(html).toContain("Allow once");
    expect(html).toContain("Deny");
    expect(html).not.toContain("Research <contract>");
  });
});
