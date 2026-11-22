export function replaceDocumentTerm(text: string, from: string, to: string) {
  const literal = from.replace(/[.*+?^\x24{}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp("(?<![\\p{L}\\p{N}])" + literal + "(?![\\p{L}\\p{N}])", "giu"), () => to);
}
