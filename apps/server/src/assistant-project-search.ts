import { basename } from "node:path";

function normalize(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().replaceAll("ß", "ss");
}
function words(value: string) { return normalize(value).match(/[\p{L}\p{N}]+/gu) ?? []; }

/** Small spelling mistakes, including a swapped pair of letters. Never fuzzy-match matter numbers. */
function distance(a: string, b: string) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
  }
  return rows[a.length][b.length];
}

/** Exact names first, then literal matches, then explicitly labelled spelling suggestions. */
export function projectMatch(project: { id: string; name: string; path: string }, query: string, metadata = "") {
  const terms = words(query);
  if (!terms.length) return query.trim() ? null : { score: 0, match: "all" };
  const name = normalize(project.name), text = normalize(`${project.name} ${project.path} ${project.id}`);
  if (words(project.name).join(" ") === terms.join(" ") || normalize(project.id) === normalize(query)) return { score: 0, match: "exact" };
  if (terms.every(term => text.includes(term))) return { score: terms.every(term => name.includes(term)) ? 1 : 2, match: "literal" };
  if (metadata && terms.every(term => normalize(`${text} ${metadata}`).includes(term))) return { score: 2.5, match: "metadata" };
  const candidates = words(`${project.name} ${basename(project.path)}`);
  let edits = 0;
  for (const term of terms) {
    if (text.includes(term)) continue;
    if (term.length < 4 || /\d/.test(term)) return null;
    const tolerance = term.length >= 8 ? 2 : 1;
    const closest = Math.min(...candidates.filter(word => !/\d/.test(word) && Math.abs(term.length - word.length) <= tolerance)
      .map(word => distance(term, word)));
    if (closest > tolerance) return null;
    edits += closest;
  }
  return { score: 3 + edits, match: "approximate" };
}
