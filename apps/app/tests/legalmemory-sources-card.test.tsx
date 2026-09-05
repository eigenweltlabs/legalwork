import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LegalMemorySourcesCard } from "@/components/chat/legalmemory-sources-card";

describe("LegalMemorySourcesCard", () => {
  test("shows five sources per page with pagination controls", () => {
    const documents = Array.from({ length: 7 }, (_, index) => ({
      documentId: `document-${index + 1}`,
      title: `Source ${index + 1}`,
    }));
    const html = renderToStaticMarkup(
      React.createElement(LegalMemorySourcesCard, {
        documents,
        matters: {},
        streaming: false,
      }),
    );

    expect(html).toContain("Source 1");
    expect(html).toContain("Source 5");
    expect(html).not.toContain("Source 6");
    expect(html).toContain("Page 1 of 2");
    expect(html).toContain('aria-label="Previous sources page"');
    expect(html).toContain('aria-label="Next sources page"');
  });

  test("does not show pagination for five or fewer sources", () => {
    const html = renderToStaticMarkup(
      React.createElement(LegalMemorySourcesCard, {
        documents: [{ documentId: "document-1", title: "Only source" }],
        matters: {},
        streaming: false,
      }),
    );

    expect(html).not.toContain("Sources pagination");
  });
});
