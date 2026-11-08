// The agent substitutes the discovered directory and verifies the firm's model and currency.
const binding = { source: "backOffice", directoryId: "<discovered directoryId>", objectId: "matters", currency: "EUR" };
const count = { name: "matters", op: "count" };
const value = { name: "value", op: "sum", field: "claimValue" };
export const PORTFOLIO_TEMPLATE = {
  purpose: "A live matter portfolio. Verify field IDs and currency in Back Office. Set includeArchived explicitly on every query if the user includes archived records. Adapt the model and measures for other dashboards.",
  queries: {
    summary: { ...binding, fields: ["matters", "value"], metrics: [count, value] },
    areas: { ...binding, fields: ["practiceArea", "matters", "value"], groupBy: "practiceArea", metrics: [count, value], sort: [{ field: "value", direction: "desc" }] },
    missing: { ...binding, fields: ["matters"], filters: [{ field: "claimValue", op: "exists", value: false }], metrics: [count] },
    register: { ...binding, fields: ["name", "fileNumber", "practiceArea", "status", "claimValue", "$archived"], sort: [{ field: "name", direction: "asc" }], limit: 200 },
  },
  program: `summary = Query("data", {name:"summary"}, {rows:[]})
areas = Query("data", {name:"areas"}, {rows:[]})
missing = Query("data", {name:"missing"}, {rows:[]})
register = Query("data", {name:"register"}, {rows:[]})
root = Stack([
  Stack([QueryMetric("Matters", summary.rows, "matters"), QueryMetric("Recorded value in dispute", summary.rows, "value", "EUR"), QueryMetric("Matters without a EUR value", missing.rows, "matters")], 3),
  Stack([RankedBars(areas.rows, "practiceArea", "value", "Value in dispute by practice area", "EUR"), PieChart(areas.rows, "practiceArea", "matters", "Matters by practice area", "pie")], 2),
  Card("Matter register", [Table(register.rows, [{field:"name",label:"Matter"},{field:"fileNumber",label:"Reference"},{field:"practiceArea",label:"Practice area"},{field:"status",label:"Status"},{field:"claimValue",label:"Value · EUR"},{field:"$archived",label:"Archived"}])])
])`,
};
