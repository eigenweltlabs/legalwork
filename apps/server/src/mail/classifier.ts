import { addressParser } from 'postal-mime';
import type { MailClassifierDefinition, MailClassifierReason, MailClassifierPreview } from './classifier-view.js';
import { mailClassifierAddressSchema } from './classifier-view.js';

function referenceMatches(subject: string, reference: string) {
  let from = 0;
  while (from <= subject.length - reference.length) {
    const at = subject.indexOf(reference, from); if (at < 0) return false;
    const before = subject.slice(Math.max(0, at - 2), at).match(/.$/u)?.[0] ?? '', after = subject.slice(at + reference.length, at + reference.length + 2).match(/^./u)?.[0] ?? '';
    if (!/[\p{L}\p{N}\p{M}_/-]/u.test(before) && !/[\p{L}\p{N}\p{M}_/-]/u.test(after)) return true;
    from = at + 1;
  }
  return false;
}

export function classifyMailProject(definition: MailClassifierDefinition, metadata: { from: string | null; subject: string | null }): Pick<MailClassifierPreview, 'status' | 'candidates'> {
  if(definition.mode==='off')return{status:'off',candidates:[]};
  const subject = (metadata.subject ?? '').toLowerCase();
  if ((metadata.from?.length ?? 0) > 65536 || subject.length > 65536) return { status: 'unavailable', candidates: [] };
  const parsed = addressParser(metadata.from ?? ''), checked = parsed.length === 1 ? mailClassifierAddressSchema.safeParse(parsed[0].address) : undefined;
  if (!checked?.success) return { status: 'unavailable', candidates: [] };
  const address = checked.data, domain = address.slice(address.lastIndexOf('@') + 1);
  const exclusions = definition.exclusions;
  if (address && exclusions.senders.includes(address) || domain && exclusions.domains.includes(domain) || exclusions.subjects.some(value => subject.includes(value.toLowerCase()))) return { status: 'excluded', candidates: [] };
  const grouped = new Map<string, { project: MailClassifierDefinition['rules'][number]['project']; rules: { id: string; name: string; reasons: MailClassifierReason[] }[] }>();
  for (const rule of [...definition.rules].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))) {
    if (!rule.enabled) continue;
    const criteria = rule.criteria;
    if (criteria.sender && address !== criteria.sender || criteria.domain && domain !== criteria.domain || criteria.reference && !referenceMatches(subject, criteria.reference.toLowerCase()) || criteria.subject && !subject.includes(criteria.subject.toLowerCase())) continue;
    const reasons: MailClassifierReason[] = [];
    if (criteria.sender) reasons.push('sender'); if (criteria.domain) reasons.push('domain'); if (criteria.reference) reasons.push('reference'); if (criteria.subject) reasons.push('subject');
    const key = JSON.stringify([rule.project.id, rule.project.binding]), candidate = grouped.get(key) ?? { project: rule.project, rules: [] };
    candidate.rules.push({ id: rule.id, name: rule.name, reasons }); grouped.set(key, candidate);
  }
  const candidates = [...grouped.values()];
  return { status: candidates.length === 0 ? 'unmatched' : candidates.length === 1 ? 'suggested' : 'ambiguous', candidates };
}
