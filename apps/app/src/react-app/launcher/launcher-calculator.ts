export type Calculation = { expression: string; value: string | null; error: "incomplete" | "undefined" | null };
type Operand = { value: number; percent: boolean };
const functions: Record<string, (value: number) => number> = { sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil };

/** A small arithmetic grammar. Never executes input or sends calculations to a model. */
export function calculate(input: string): Calculation | null {
  const expression = input.trim().replace(/^=\s*/, "");
  if (!expression || expression.length > 200) return null;
  if (!/^[\d\s.,()+\-*/^%×÷−a-zπ]+$/i.test(expression)) return null;
  const normalized = expression.toLowerCase().replaceAll("×", "*").replaceAll("÷", "/").replaceAll("−", "-").replaceAll(",", ".").replaceAll("π", "pi");
  const tokens = normalized.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-z]+|[^\s]/g) ?? [];
  if (tokens.some(token => /^[a-z]+$/.test(token) && !["pi", "e", ...Object.keys(functions)].includes(token))) return null;
  if (!input.trim().startsWith("=") && !/[+*/^%()]/.test(normalized) && !/\d\s*-\s*\d/.test(normalized) && !/^(pi|π|e)$/.test(expression)) return null;
  // Paths and ordinary prose remain searches even if they contain punctuation.
  if (!/^(?:[\d.(+\-]|pi\b|e\b|sqrt\b|abs\b|round\b|floor\b|ceil\b)/.test(normalized)) return null;
  let cursor = 0;
  const take = (token: string) => { if (tokens[cursor] !== token) return false; cursor++; return true; };
  const operand = (value: number, percent = false): Operand => ({ value, percent });
  function primary(): Operand {
    let value: number;
    if (take("(")) { value = sum().value; if (!take(")")) throw new Error("incomplete"); }
    else {
      const token = tokens[cursor++];
      if (token === "pi") value = Math.PI;
      else if (token === "e") value = Math.E;
      else if (token && Object.hasOwn(functions, token)) {
        if (!take("(")) throw new Error("incomplete");
        value = functions[token](sum().value);
        if (!take(")")) throw new Error("incomplete");
      } else {
        if (!token || !/^(?:\d|\.\d)/.test(token)) throw new Error("incomplete");
        value = Number(token);
      }
    }
    return take("%") ? operand(value / 100, true) : operand(value);
  }
  function power(): Operand {
    const left = primary();
    return take("^") ? operand(left.value ** unary().value) : left;
  }
  function unary(): Operand {
    if (take("+")) return unary();
    if (take("-")) { const right = unary(); return operand(-right.value, right.percent); }
    return power();
  }
  function product(): Operand {
    let left = unary();
    while (tokens[cursor] === "*" || tokens[cursor] === "/") {
      const operator = tokens[cursor++];
      const right = unary();
      left = operand(operator === "*" ? left.value * right.value : left.value / right.value);
    }
    return left;
  }
  function sum(): Operand {
    let left = product();
    while (tokens[cursor] === "+" || tokens[cursor] === "-") {
      const operator = tokens[cursor++];
      const right = product();
      const value = right.percent ? left.value * right.value : right.value;
      left = operand(operator === "+" ? left.value + value : left.value - value);
    }
    return left;
  }
  try {
    const result = sum().value;
    if (cursor !== tokens.length) return { expression, value: null, error: "incomplete" };
    if (!Number.isFinite(result)) return { expression, value: null, error: "undefined" };
    return { expression, value: String(Number(result.toPrecision(12))), error: null };
  } catch { return { expression, value: null, error: "incomplete" }; }
}
