import type { TimesheetState } from "@legalwork/types/timesheet";
import type { CaptureProposal } from "@legalwork/types/time-capture";

const words = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const general = new Set(words("a an and at by for from in of on the to und der die das des für mit von zum zur im am projekt project case matter demo file document review draft final revision notes meeting minutes memo report version update status contract agreement work template copy internal external client project document documents untitled scan appendix attachment letter checklist presentation spreadsheet email call invoice draft pdf doc docx xls xlsx ppt pptx entwurf notizen vertrag prüfung akte vorlage kopie anlage"));
const legalForms = new Set(words("gmbh ag ug mbh llp llc inc corp ltd limited plc project projekt demo group company co kg ggmbh eg partners"));

function phrase(text: string[], terms: string[]) {
  return terms.length > 0 && text.some((word, index) => word === terms[0] && terms.every((term, offset) => text[index + offset] === term));
}

function observationTitle(p: CaptureProposal) {
  if (p.source === "desktop") return p.desktopContext?.documentName ?? (p.fileUseSource ? p.narrative : undefined);
  if (p.source === "agent" || p.source === "workspace" || p.source === "stopwatch") return;
  return p.narrative;
}

/** Find at most one accessible matter using only the observation's own explicit title. */
export function matterTitleMatcher(state: Pick<TimesheetState, "matters" | "clients" | "projects">) {
  const clients = new Map(state.clients.map(client => [client.id, client.name]));
  const candidates = state.matters.map(matter => {
    // A common display name is "Client | Matter title". That prefix can identify the client, never the matter by itself.
    const parts = matter.name.split("|");
    const subject = parts.length > 1 ? parts.slice(1).join(" ") : matter.name;
    const parties = [...matter.clientIds.flatMap(id => clients.get(id) ?? []), ...(parts.length > 1 ? [parts[0]] : [])]
      .map(name => words(name).filter(word => !legalForms.has(word) && !general.has(word)))
      .filter(tokens => tokens.some(word => word.length >= 3));
    const partyWords = new Set(parties.flat());
    const terms = [...new Set(words(subject).filter(word => word.length >= 3 && !general.has(word) && !partyWords.has(word)))];
    const reference = words(matter.reference);
    // Single years and short numbers are common in filenames. A complete structured file reference is stronger.
    const structured = reference.join("").length >= 4 && reference.some(word => /\d/u.test(word))
      && (reference.some(word => /\p{L}/u.test(word)) || reference.length > 1);
    return { matter, parties, terms, reference: structured ? reference : [] };
  });
  return (proposal: CaptureProposal) => {
    const title = observationTitle(proposal);
    if (!title) return;
    const tokens = words(title);
    if (!tokens.length) return;
    const substantive = tokens.filter(word => !general.has(word) && word.length >= 3);
    const named = new Set(candidates.filter(candidate => candidate.parties.some(party => phrase(tokens, party))).map(candidate => candidate.matter.id));
    const matches = candidates.filter(({ matter, terms, reference }) => {
      if (phrase(tokens, reference)) return true;
      const withClient = named.has(matter.id);
      if (named.size && !withClient) return false;
      if (terms.length < 2 || !terms.some(word => /\p{L}/u.test(word))) return false;
      // A named client or case needs a matching phrase from its matter title. Without that label, require the whole title.
      return withClient ? terms.slice(1).some((word, i) => phrase(substantive, [terms[i], word])) : phrase(substantive, terms);
    });
    if (matches.length !== 1) return;
    const [{ matter, reference }] = matches;
    if (named.size && !named.has(matter.id)) return;
    const linked = state.projects.find(project => project.id === proposal.projectId)?.matterIds;
    if (linked?.length && !linked.includes(matter.id)) return;
    return { matter, basis: phrase(tokens, reference) ? "reference" as const : "title" as const };
  };
}
