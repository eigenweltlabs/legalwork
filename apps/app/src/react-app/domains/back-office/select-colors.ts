const colors: Record<
  string,
  "green" | "blue" | "yellow" | "purple" | "orange" | "pink"
> = {
  Active: "green",
  Intake: "blue",
  "On hold": "yellow",
  Closed: "purple",
  Submitted: "blue",
  Approved: "green",
  Draft: "blue",
  Invoiced: "purple",
  "Written off": "orange",
  Paid: "green",
  Issued: "blue",
  "Part paid": "yellow",
  Cancelled: "orange",
  "Corporate / M&A": "blue",
  Employment: "purple",
  Commercial: "green",
  Disputes: "orange",
  Privacy: "pink",
  "Real estate": "green",
};

export function selectColor(value: string) {
  return colors[value] ?? "blue";
}
