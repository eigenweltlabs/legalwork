/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantIdentity } from "../src/react-app/domains/session/sidebar/assistant-identity";
import { AssistantAvatar } from "../src/react-app/domains/session/sidebar/assistant-appearance";

test("animated avatars provide a still-image source for reduced motion", () => {
  const working = renderToStaticMarkup(<AssistantAvatar icon="cat" motion="thinking" />);
  expect(working).toContain("cat-thinking.webp");
  expect(working).toContain('media="(prefers-reduced-motion: reduce)"');
  expect(working).toContain("cat-idle.png");
  const idle = renderToStaticMarkup(<AssistantAvatar icon="cat" motion="idle" />);
  expect(idle).toContain("cat-idle.png");
  expect(idle).not.toContain("cat-thinking.webp");
});

test("sidebar avatars stay static and the dot remains an SVG during activity", () => {
  const sidebar = renderToStaticMarkup(<AssistantAvatar icon="cat" />);
  expect(sidebar).not.toContain("thinking.webp");
  expect(sidebar).not.toContain("<picture");
  const dot = renderToStaticMarkup(<AssistantAvatar icon="dot" motion="thinking" />);
  expect(dot).toContain("<svg");
  expect(dot).not.toContain("<img");
});


test("the top Assistant avatar loops while idle as well as while working", () => {
  const html = renderToStaticMarkup(<AssistantIdentity workspaceId="fixture" sessionId="idle" profile={{ name: "Johann", icon: "cat" }} />);
  expect(html).toContain("cat-thinking.webp");
  expect(html).toContain('media="(prefers-reduced-motion: reduce)"');
});
