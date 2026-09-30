import { describe, expect, test } from "bun:test";

import { mergeableText, mergeText } from "./text-merge.js";

describe("merging text", () => {
  const base = "# Termin\n\nMandant kommt am Montag.\n\nUnterlagen: Vertrag, Rechnung.\n";

  test("changes to different lines are both kept", () => {
    const anna = base.replace("Montag", "Dienstag");
    const ben = base.replace("Rechnung.", "Rechnung, Vollmacht.");
    expect(mergeText(base, anna, ben)).toBe("# Termin\n\nMandant kommt am Dienstag.\n\nUnterlagen: Vertrag, Rechnung, Vollmacht.\n");
  });

  test("changes to different words of one paragraph are both kept", () => {
    const paragraph = "Der Mandant kommt am Montag um zehn Uhr in die Kanzlei.";
    const anna = paragraph.replace("Montag", "Dienstag");
    const ben = paragraph.replace("zehn Uhr", "elf Uhr");
    expect(mergeText(paragraph, anna, ben)).toBe("Der Mandant kommt am Dienstag um elf Uhr in die Kanzlei.");
  });

  test("a line edited on one side and a paragraph added right below it on the other are both kept", () => {
    expect(mergeText("# Termin\n", "# Termin am Montag\n", "# Termin\n\nMit Vollmacht.\n")).toBe("# Termin am Montag\n\nMit Vollmacht.\n");
  });

  test("both changing the same words differently needs a person", () => {
    expect(mergeText(base, base.replace("Montag", "Dienstag"), base.replace("Montag", "Freitag"))).toBeNull();
  });

  test("one side unchanged, or both the same, is simply the change", () => {
    const changed = base.replace("Montag", "Dienstag");
    expect(mergeText(base, base, changed)).toBe(changed);
    expect(mergeText(base, changed, base)).toBe(changed);
    expect(mergeText(base, changed, changed)).toBe(changed);
    expect(mergeText("", "neu", "")).toBe("neu");
  });

  test("text without a final line break merges too", () => {
    expect(mergeText("a\nb\nc", "A\nb\nc", "a\nb\nC")).toBe("A\nb\nC");
  });

  test("only text a person writes is merged", () => {
    expect(mergeableText("Notes/Hallo-ee006b29.md")).toBe(true);
    expect(mergeableText("Notizen.TXT")).toBe(true);
    expect(mergeableText("Klage.docx")).toBe(false);
    expect(mergeableText("daten.json")).toBe(false);
  });
});
