import { createLibrary, createParser, defineComponent, enrichErrors, type OpenUIError } from "@openuidev/lang-core";
import { isLocalOpenUIProgram, schemas } from "./catalog.js";

const library = createLibrary({
  components: Object.entries(schemas).map(([name, props]) =>
    defineComponent({ name, props, description: "", component: null })
  ),
});
const schema = library.toJSONSchema();
const parser = createParser(schema);
const names = Object.keys(schemas);

export function dashboardComponentSchemas(component?: string) {
  const entries = Object.entries(schemas).filter(([name]) => component === undefined || name === component);
  return Object.fromEntries(entries.map(([name, props]) => [
    name, { ...schema.$defs?.[name], parameterOrder: Object.keys(props.shape) },
  ]));
}

/** Use the renderer's parser on the complete program before resolving any queries or writing a file. */
export function dashboardProgramErrors(program: string, bindings: string[]): OpenUIError[] {
  const issue = (message: string): OpenUIError => ({ source: "parser", code: "parse-failed", message });
  if (!isLocalOpenUIProgram(program)) return [issue("Use the bundled OpenUI language without scripts or hosted response bundles.")];
  const result = parser.parse(program);
  const errors = enrichErrors(result.meta.errors, schema, names);
  for (const error of errors) {
    if (error.path === "/children" && (error.component === "Card" || error.component === "Stack")) {
      error.hint = "Wrap children in square brackets, including a single chart or table.";
    }
  }
  if (result.meta.incomplete) errors.push(issue("Complete the unfinished OpenUI expression."));
  if (!result.root && !errors.length) errors.push(issue("Assign a dashboard component to root."));
  if (result.meta.unresolved.length) errors.push(issue("Define these referenced statements: " + result.meta.unresolved.join(", ")));
  for (const query of result.queryStatements) {
    const name = query.argsAST?.k === "Obj" ? query.argsAST.entries.find(([key]) => key === "name")?.[1] : undefined;
    if (query.toolAST?.k !== "Str" || !["data", "wiki_query"].includes(query.toolAST.v)) {
      errors.push({ ...issue("Read a named binding with Query(\"data\", {name:\"binding\"})."), statementId: query.statementId });
    } else if (name?.k === "Str" && !bindings.includes(name.v)) {
      errors.push({ ...issue(`Unknown data binding "${name.v}". Supply it in queries or datasets.`), statementId: query.statementId });
    }
  }
  return errors;
}
