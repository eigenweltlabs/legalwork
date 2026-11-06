/** Read the standard schedule fields without evaluating or rewriting the series. */
export function calendarRecurrence(rules: string[]) {
  const rule = rules.find(value => value.startsWith("RRULE:"));
  if (!rule) return null;
  const fields = new Map(rule.slice(6).split(";").map(part => {
    const index = part.indexOf("=");
    return [part.slice(0, index), part.slice(index + 1)];
  }));
  const positive = (value: string | undefined) => value && /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null;
  const until = fields.get("UNTIL");
  return {
    frequency: fields.get("FREQ") ?? "", interval: positive(fields.get("INTERVAL")) ?? 1,
    days: (fields.get("BYDAY") ?? "").split(",").filter(Boolean),
    monthDays: (fields.get("BYMONTHDAY") ?? "").split(",").filter(Boolean),
    count: positive(fields.get("COUNT")),
    until: until && /^\d{8}(?:T\d{6}Z?)?$/.test(until) ? `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` : null,
    advanced: [...fields.keys()].some(key => !["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "COUNT", "UNTIL", "WKST"].includes(key)) || rules.some(value => !value.startsWith("RRULE:")),
  };
}
