import { expect, test } from "bun:test";
import { calculate } from "../src/react-app/launcher/launcher-calculator";

test("local calculator handles precedence, parentheses, negative powers and decimal precision", () => {
  for (const [expression, value] of [["2 + 3 * 4", "14"], ["(2+3)*4", "20"], ["2^3^2", "512"], ["-2^2", "-4"], ["2^-2", "0.25"], ["0.1 + 0.2", "0.3"], ["1,5 × 2", "3"], ["5−2", "3"], ["10÷4", "2.5"], ["sqrt(81)", "9"], ["abs(-7)", "7"], ["round(2.6)", "3"], ["=42", "42"]]) {
    expect(calculate(expression)?.value).toBe(value);
  }
});

test("percentages work as factors and as relative increases or discounts", () => {
  expect(calculate("200 * 15%")?.value).toBe("30");
  expect(calculate("200 + 15%")?.value).toBe("230");
  expect(calculate("200 - 15%")?.value).toBe("170");
  expect(calculate("50%")?.value).toBe("0.5");
});

test("ordinary searches and executable text never become calculations", () => {
  for (const input of ["lease", "file.pdf", "report 2 + annex 3", "2026", "f 2+2", "? 2+2", "alert(1)", "process.exit()", "1;alert(2)", "a/b", "Math.random()", "x".repeat(1000)]) expect(calculate(input)).toBeNull();
});

test("incomplete and undefined calculations do not produce a copyable result", () => {
  for (const expression of ["2+", "(2+3", "sqrt(", "2**3"]) expect(calculate(expression)?.error).toBe("incomplete");
  for (const expression of ["1/0", "0/0", "sqrt(-1)", "10^1000"]) expect(calculate(expression)).toMatchObject({ value: null, error: "undefined" });
});
