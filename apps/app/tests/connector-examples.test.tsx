import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { currentLocale, setLocale, type Language } from "../src/i18n";
import { connectorExamples, type ConnectorExampleKind } from "../src/react-app/domains/settings/pages/connector-examples";
import { ConnectorOverview } from "../src/react-app/domains/settings/pages/connector-overview";

test("examples stay provider-specific and fully translated in English and German", () => {
  const previous = currentLocale();
  try {
    const languages: Language[] = ["en", "de"];
    for (const language of languages) {
      setLocale(language);
      const kinds: ConnectorExampleKind[] = ["files", "mail", "calendar", "research", "website"];
      for (const kind of kinds) {
        const examples = connectorExamples(kind, "Example account");
        expect(examples).toHaveLength(2);
        for (const example of examples) {
          expect(example).toContain("Example account");
          expect(example).not.toMatch(/catalog\.|\{name\}/);
        }
      }
      const beck = connectorExamples("research", "beck-online", "beck-online");
      expect(beck[0]).toContain(language === "de" ? "Kommentierungen" : "commentary");
      expect(beck[1]).toContain("beck-online");
      const juris = connectorExamples("research", "juris", "juris");
      expect(juris[0]).toContain(language === "de" ? "Aktenzeichen" : "case number");
      expect(juris[1]).toContain("juris");
      expect(beck[0]).toStartWith(language === "de" ? "Hilf" : "Help");
      const html = renderToStaticMarkup(<ConnectorOverview kind="research" name="beck-online" description="" providerId="beck-online" facts={[]} />);
      expect(html).toContain(language === "de" ? 'aria-label="Beispiel kopieren: Hilf' : 'aria-label="Copy example: Help');
      expect(html).toContain('type="button"');
      expect(html).not.toContain("catalog.");
    }
  } finally { setLocale(previous); }
});
