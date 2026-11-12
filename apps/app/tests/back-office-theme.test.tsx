import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useThemeColorScheme } from "twenty-ui/theme";
import { setThemeMode } from "../src/app/theme";
import { BackOfficeTheme } from "../src/react-app/domains/back-office/twenty-controls";

function ThemeProbe() {
  const scheme = useThemeColorScheme();
  return <span data-scheme={scheme}>Back Office</span>;
}
const render = () => renderToStaticMarkup(
  <BackOfficeTheme><ThemeProbe /></BackOfficeTheme>,
);
afterEach(() => setThemeMode("light"));

test("uses LegalWork's dark appearance without requiring a dark class on the document", () => {
  setThemeMode("dark");
  const html = render();
  expect(html).toContain('class="dark bo-theme"');
  expect(html).toContain('data-scheme="dark"');
});

test("follows light appearance after switching from dark", () => {
  setThemeMode("dark");
  expect(render()).toContain('data-scheme="dark"');
  setThemeMode("light");
  const html = render();
  expect(html).toContain('class="light bo-theme"');
  expect(html).toContain('data-scheme="light"');
});

test("uses Twenty's dark palette for LegalWork Blackout", () => {
  setThemeMode("blackout");
  expect(render()).toContain('data-scheme="dark"');
});
