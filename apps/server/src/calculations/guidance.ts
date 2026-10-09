import { z } from "zod";
import { DEADLINE_SKILLS, DeadlineInputSchema } from "../calendar/deadline-rules.js";

/** Returned beside installed instructions, including older packages, without changing their fingerprints. */
export function deadlineToolGuide(names: string[]) {
  const skills = DEADLINE_SKILLS.filter(skill => names.includes(skill.name));
  if (!skills.length) return undefined;
  return {
    instruction: "Use the tools directly. Their complete calculator input contract is below. Do not read, grep, import, probe or run calculate.mjs, inspect dependencies, or search application/configuration folders to discover a tool. No external-folder access is needed. If a tool reports invalid inputs, correct the named fields from the evidence; if it is unavailable or refuses coverage, explain that limitation and stop. Do not repair or reverse-engineer the app from a legal task.",
    skills: skills.map(({ name, rules }) => ({ name, rules })),
    calculate: {
      tool: "legalwork_deadline_calculate",
      argumentsSchema: z.toJSONSchema(z.object({ skill: z.enum(skills.map(skill => skill.name)), input: DeadlineInputSchema }), { io: "input" }),
      guidance: "For an ordinary German ZPO period, supply rule=de-zpo-period, the established triggerDate, duration, unit, region and source. region uses Bundesland codes (e.g. NW for Nordrhein-Westfalen, BE for Berlin). Only supply other facts when applicable and established. The tool handles counting and holiday adjustments; do not inspect its implementation to check them. Calculate only the requested deadline. A statement of defence and a notice of intention to defend are separate deadlines.",
    },
    present: {
      tool: "legalwork_calculation_present",
      guidance: "After calculation, pass calculationIds=[referenceData.calculation.id], a short title naming the requested deadline, selection explaining the legal basis in one sentence, and sources=[{path, page, quote}]. Paths are project-relative, PDF pages are one-based, and text-file page is null. Multiple calculationIds are supported for multiple requested deadlines. Use the language of the user's request for the title, selection and any reply; keep source quotes verbatim in the document's language. Never search app folders for a tool or source. The tool is already available. Show the card as part of using this shipped skill, without requiring the user to ask for a card. The card is the response; do not repeat its result in prose.",
    },
    interaction: CALCULATION_INTERACTION_GUIDANCE,
  };
}

/** Shared by the shipped skills and the agent's current interaction policy. */
export const CALCULATION_INTERACTION_GUIDANCE = `Read the relevant documents and loaded skill before asking questions. Reuse facts already supplied. A known court can establish its location; do not ask the user to restate it. Never guess a missing service event, period, procedural development or applicable rule. Only ask for facts that could change the requested result and are not available in the record. Do not turn hypothetical exceptions or every optional calculator field into a questionnaire. Unsupported executable coverage is a limitation to explain, not a reason to ask irrelevant questions. Use the calculator tool's input schema directly; do not inspect bundled dependencies, probe scripts with empty inputs or run the executable separately. Describe facts supplied in chat as user-provided facts, not an invented document.

When presenting a supported calculation with sufficient facts, use legalwork_calculation_present with mode=show by default. Show the actual receipt, concise selection and exact source quotations as evidence. Do not ask whether to calculate, show the card or confirm established inputs. If the user only asked to calculate or explain, do not create a calendar entry. If the user asked to add the deadline, save the exact receipt with legalwork_calendar_create and show its calculation; do not add another approval step or claim it was human-verified. Only report a save after the tool succeeds. Keep the response short. Use human-readable dates and durations in all user-facing text, including save/edit confirmations: say one day before the deadline, not 1440 minutes or raw timestamps. Do not repeat internal IDs, schema/code details or equivalent technical units.

Use mode=confirm only when the user explicitly requests review/approval before saving, or an applicable substantive skill rule requires human approval. Then stop for the card's buttons. Never bypass a pending or rejected confirmation by presenting it again in show mode. General advice in older bundled skills to confirm every calculation is replaced by this policy; actual calculation coverage and explicit review requirements still apply.

If material facts are missing, present an assessment with no date in show mode and ask the smallest focused question needed to continue. Ask about the legally controlling event, not a merely related event. Do not request a generic approval: approval cannot supply a missing fact. Do not offer a manual date as a shortcut for an unknown legal result; manual entry is for a date the user independently supplies or explicitly requests. An unknown absolute statutory cutoff must not be replaced by an ordinary diary date. Once the user supplies the missing fact, recalculate and proceed with their original request. The widget remains optional for community skills.`;
