import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FormInfo } from "@opencode/client";
import { NativeFormPanel } from "../src/react-app/domains/session/modals/native-form-panel";

const form: FormInfo = {
  id: "insurance", sessionID: "chat", title: "Questions",
  fields: [{
    key: "insurance", type: "string", title: "Versicherungsannahme", required: true,
    description: "Welche Variante soll ich vergleichen?",
    options: [
      { value: "both", label: "Beide vergleichen", description: "Beide Varianten im Vergleich." },
      { value: "employed", label: "Volle Sozialversicherung", description: "Alle Beiträge berücksichtigen." },
    ],
  }],
};

const render = (request = form, busy = false) => renderToStaticMarkup(
  <NativeFormPanel form={request} busy={busy} onReply={() => {}} onCancel={() => {}} />,
);

const steps: FormInfo = {
  ...form,
  metadata: { kind: "question" },
  fields: [form.fields[0], {
    key: "focus", type: "multiselect", required: true, custom: true,
    description: "What should I focus on?",
    options: [{ value: "liability", label: "Liability" }, { value: "term", label: "Term and termination" }],
  }],
};

describe("native question choices", () => {
  test("shows one question at a time with its progress and navigation", () => {
    const html = render(steps);
    expect(html).toContain('aria-label="Question 1 of 2"');
    expect(html).toContain("1 / 2");
    expect(html).toContain("Welche Variante soll ich vergleichen?");
    expect(html).not.toContain("What should I focus on?");
    expect(html).not.toContain("Term and termination");
    expect(html).toMatch(/<button(?=[^>]* disabled="")[^>]*>[\s\S]*?Back<\/button>/);
    expect(html).toContain("Next");
    expect(html).not.toContain(">Send</button>");
  });

  test("an unanswered later question cannot block advancing from an answered step", () => {
    const html = render({ ...steps, fields: [{ ...form.fields[0], type: "string", default: "both" }, steps.fields[1]] });
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]* disabled=""/);
  });

  test("hidden questions are omitted from the step counter", () => {
    const html = render({ ...steps, fields: [{ key: "internal", type: "string", hidden: true }, ...steps.fields] });
    expect(html).toContain('aria-label="Question 1 of 2"');
    expect(html).not.toContain("internal");
  });

  test("a single question keeps Send without step navigation", () => {
    const html = render({ ...form, metadata: { kind: "question" } });
    expect(html).not.toContain("Question 1 of");
    expect(html).not.toContain(">Back</button>");
    expect(html).toContain(">Send</button>");
  });

  test("integration forms keep all their fields together", () => {
    const html = render({ ...steps, metadata: {} });
    expect(html).toContain("Welche Variante soll ich vergleichen?");
    expect(html).toContain("What should I focus on?");
    expect(html).not.toContain("Question 1 of");
    expect(html).toContain(">Send</button>");
  });

  test("offers Skip and Close without submitting or requiring an answer", () => {
    const html = render();
    expect(html).toMatch(/<button(?=[^>]*aria-label="Close")(?=[^>]*type="button")[^>]*>/);
    expect(html).toMatch(/<button(?=[^>]*type="button")[^>]*>Skip<\/button>/);
    expect(html).not.toMatch(/<button(?=[^>]*aria-label="Close")(?=[^>]* disabled="")[^>]*>/);
    expect(html).not.toMatch(/<button(?=[^>]* disabled="")[^>]*>Skip<\/button>/);
  });

  test("disables both cancellation controls while a request is in progress", () => {
    const html = render(form, true);
    expect(html).toMatch(/<button(?=[^>]*aria-label="Close")(?=[^>]* disabled="")[^>]*>/);
    expect(html).toMatch(/<button(?=[^>]* disabled="")[^>]*>Skip<\/button>/);
  });

  test("omits dismissal controls for integration forms without a cancel action", () => {
    const html = renderToStaticMarkup(<NativeFormPanel form={form} busy={false} onReply={() => {}} />);
    expect(html).not.toContain('aria-label="Close"');
    expect(html).not.toContain(">Skip</button>");
  });

  test("shows labeled choices and descriptions without a native dropdown", () => {
    const html = render();
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="radio"');
    expect(html).toContain("Beide Varianten im Vergleich.");
    expect(html).toContain("Alle Beiträge berücksichtigen.");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<datalist");
  });

  test("keeps the engine's default value selected rather than the display label", () => {
    const html = render({ ...form, fields: [{ ...form.fields[0], type: "string", default: "employed" }] });
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('value="employed"');
    expect(html).not.toContain('value="Volle Sozialversicherung"');
  });

  test("shows a controlled custom answer alongside suggested options", () => {
    const html = render({ ...form, fields: [{ ...form.fields[0], type: "string", custom: true, default: "Private Versicherung" }] });
    expect(html).toContain('role="radio"');
    expect(html).toContain('value="Private Versicherung"');
    expect(html).toContain("Or type a custom answer");
    expect(html).not.toContain("<datalist");
    expect(html.indexOf('aria-label="Or type a custom answer"')).toBeGreaterThan(html.lastIndexOf("</fieldset>"));
    expect(html).toContain(">Send</button>");
  });

  test("shows the question once with numbered choices", () => {
    const html = render();
    expect(html).toContain(">1</span>");
    expect(html).toContain(">2</span>");
    expect(html.split("Welche Variante soll ich vergleichen?")).toHaveLength(2);
  });

  test("groups multiple choices without nested labels", () => {
    const html = render({ ...form, fields: [{
      key: "choice", type: "multiselect", title: "Choose several", required: true,
      options: [{ value: "a", label: "First", description: "First description" }, { value: "b", label: "Second" }],
      default: ["a"], custom: true,
    }] });
    expect(html).toContain("<fieldset");
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('aria-checked="true"');
    expect(html).not.toMatch(/<label[^>]*>(?:(?!<\/label>)[\s\S])*<label/);
  });

  test("disables submission until visible required choices are answered", () => {
    expect(render()).toMatch(/<button[^>]*type="submit"[^>]* disabled=""/);
    const html = render({ ...form, fields: [{ ...form.fields[0], type: "string", default: "both" }] });
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]* disabled=""/);
  });

  test("disables the choice group while a reply is submitting", () => {
    expect(render(form, true)).toMatch(/<fieldset[^>]* disabled=""/);
    expect(render()).not.toMatch(/<fieldset[^>]* disabled=""/);
  });

  test("ignores hidden required questions when enabling submit", () => {
    const html = render({ ...form, fields: [{ ...form.fields[0], type: "string", hidden: true }] });
    expect(html).not.toContain("Versicherungsannahme");
    expect(html).not.toMatch(/<button[^>]*type="submit"[^>]* disabled=""/);
  });

  test("checks multi-answer limits before allowing submission", () => {
    const request: FormInfo = { ...form, fields: [{
      key: "choice", type: "multiselect", minItems: 2, maxItems: 2,
      options: [{ value: "a", label: "First" }, { value: "b", label: "Second" }],
      custom: true, default: ["a"],
    }] };
    expect(render(request)).toMatch(/<button[^>]*type="submit"[^>]* disabled=""/);
    expect(render({ ...request, fields: [{ ...request.fields[0], type: "multiselect", options: [], default: ["a", "b"] }] }))
      .not.toMatch(/<button[^>]*type="submit"[^>]* disabled=""/);
    expect(render({ ...request, fields: [{ ...request.fields[0], type: "multiselect", options: [], default: ["a", "b", "c"] }] }))
      .toMatch(/<button[^>]*type="submit"[^>]* disabled=""/);
  });

  test("preserves string constraints on custom answers with suggested choices", () => {
    const html = render({ ...form, fields: [{
      ...form.fields[0], type: "string", custom: true, format: "email", minLength: 3, maxLength: 80, pattern: ".+@.+",
    }] });
    expect(html).toContain('type="email"');
    expect(html).toContain('minLength="3"');
    expect(html).toContain('maxLength="80"');
    expect(html).toContain('pattern=".+@.+"');
  });
});
