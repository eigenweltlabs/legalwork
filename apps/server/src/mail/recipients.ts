import { mailAddressSchema } from './local-view.js';

/** Split editable address lists without treating quoted display names as recipients. */
export function mailRecipientParts(value: string): string[] {
  const parts: string[] = [];
  let quoted = false, escaped = false, angle = 0, start = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && character === '\\') { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === '<') angle++;
    else if (character === '>') angle = Math.max(0, angle - 1);
    else if (angle === 0 && /[,;\r\n]/.test(character)) { parts.push(value.slice(start, index)); start = index + 1; }
  }
  parts.push(value.slice(start));
  return parts;
}

export function mailRecipientAddress(raw: string): string | null {
  const value = raw.trim();
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  if (mailAddressSchema.safeParse(value).success) return value;
  const named = /^([^<>]*)<([^<>]+)>$/.exec(value);
  if (!named) return null;
  let quoted = false, escaped = false;
  for (const character of named[1]) {
    if (escaped) { escaped = false; continue; }
    if (quoted && character === '\\') { escaped = true; continue; }
    if (character === '"') quoted = !quoted;
    else if (!quoted && /[,;:]/.test(character)) return null;
  }
  const address = named[2].trim();
  return !quoted && !escaped && mailAddressSchema.safeParse(address).success ? address : null;
}

export function mailRecipientAddresses(value: string): string[] {
  return mailRecipientParts(value).flatMap(part => { const address = mailRecipientAddress(part); return address ? [address] : []; });
}
export function mailRecipientsInvalid(value: string): boolean {
  return mailRecipientParts(value).some(part => part.trim() !== '' && mailRecipientAddress(part) === null);
}
