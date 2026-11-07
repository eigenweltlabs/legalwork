const colors: Record<
  string,
  "green" | "blue" | "yellow" | "gray" | "purple" | "orange" | "pink"
> = {
  Active: "green",
  Intake: "blue",
  "On hold": "yellow",
  Closed: "gray",
  Submitted: "blue",
  Approved: "green",
  Draft: "gray",
  Invoiced: "purple",
  "Written off": "orange",
  Paid: "green",
  Issued: "blue",
  "Part paid": "yellow",
  Cancelled: "gray",
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
