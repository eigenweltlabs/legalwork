import { expect, test } from "bun:test";
import { createParser } from "@openuidev/react-lang";
import { renderToStaticMarkup } from "react-dom/server";
import { formatMetric, openUILibrary, OpenUIView } from "./runtime";

test("all stock chart adapters can be used independently in a custom layout", () => {
  const parser = createParser(openUILibrary.toJSONSchema());
  for (const kind of ["HorizontalBarChart", "BarChart", "StackedBarChart", "LineChart", "AreaChart", "PieChart", "FunnelChart"]) {
    const value = ["PieChart","FunnelChart"].includes(kind) ? '"count"' : '["count"]';
    expect(parser.parse(`root = ${kind}([{area:"Commercial",count:10}], "area", ${value})`).meta.errors).toEqual([]);
  }
});

test("new and previously saved metrics group numbers using the active app language", () => {
  expect(formatMetric("EUR 6186000.00","en")).toBe("€6,186,000.00");
  expect(formatMetric(6186000,"de","EUR")).toBe(new Intl.NumberFormat("de",{style:"currency",currency:"EUR"}).format(6186000));
  expect(formatMetric("001041","en")).toBe("001041");
  expect(formatMetric(0,"en","EUR")).toBe("€0.00");
  expect(formatMetric("1h 46m","de")).toBe("1h 46m");
  const html = renderToStaticMarkup(<OpenUIView locale="en" program={'root = QueryMetric("Portfolio", [{value:6186000}], "value", "EUR")'} />);
  expect(html).toContain("€6,186,000.00");
});
