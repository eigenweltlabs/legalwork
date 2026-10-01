"""Populate a Word template from JSON without rebuilding its design.

Input: {"fields": {"token": "value"}, "tables": [{"tokens": ["id", "issue"],
"rows": [{"id": "F-01", "issue": "Source-supported finding"}]}]}.
Only original template tokens are substituted; inserted text is never reinterpreted.
"""
import argparse
import copy
import json
from pathlib import Path
import re
from zipfile import ZipFile

from docx import Document

TOKEN = re.compile(r"\{\{([\w.-]+)\}\}")


def paragraphs(container):
    yield from container.paragraphs
    for table in container.tables:
        seen = set()
        for row in table.rows:
            for cell in row.cells:
                if cell._tc in seen:
                    continue
                seen.add(cell._tc)
                yield from paragraphs(cell)


def all_paragraphs(doc):
    yield from paragraphs(doc)
    seen = set()
    for section in doc.sections:
        for part in [section.header, section.footer, section.first_page_header, section.first_page_footer,
                     section.even_page_header, section.even_page_footer]:
            if part.is_linked_to_previous:
                continue
            if part.part.partname in seen:
                continue
            seen.add(part.part.partname)
            yield from paragraphs(part)


def substitute(paragraph, fields):
    text = paragraph.text
    matches = list(TOKEN.finditer(text))
    runs = paragraph.runs
    # Work from the end so earlier character positions remain stable, even
    # for a token split across several differently formatted runs.
    for match in reversed(matches):
        key = match.group(1)
        if key not in fields:
            raise ValueError("Missing template field: " + key)
        start, end = match.span()
        position = 0
        located = []
        for run in runs:
            run_start, run_end = position, position + len(run.text)
            if run_end > start and run_start < end:
                located.append((run, run_start))
            position = run_end
        if not located:
            raise ValueError("Cannot locate token runs: " + key)
        first, first_start = located[0]
        last, last_start = located[-1]
        replacement = str(fields[key])
        if first is last:
            first.text = first.text[:start - first_start] + replacement + first.text[end - first_start:]
        else:
            prefix, suffix = first.text[:start - first_start], last.text[end - last_start:]
            first.text = prefix + replacement
            for run, _ in located[1:-1]:
                run.text = ""
            last.text = suffix


def inspect(doc):
    return {"fields": sorted({key for p in all_paragraphs(doc) for key in TOKEN.findall(p.text)}),
            "repeat_rows": [{"table": i, "row": j, "tokens": sorted({key for cell in row.cells for p in paragraphs(cell) for key in TOKEN.findall(p.text)})}
                            for i, table in enumerate(doc.tables) for j, row in enumerate(table.rows)
                            if any(TOKEN.search(p.text) for cell in row.cells for p in paragraphs(cell))]}


def populate(template, plan, output):
    if Path(template).resolve() == Path(output).resolve():
        raise ValueError("Write to a new output file; preserve the base template.")
    doc = Document(template)
    fields = plan["fields"]
    if not isinstance(fields, dict) or any(not isinstance(value, (str, int, float)) for value in fields.values()):
        raise ValueError("Fields must be a map of token names to text/numbers.")
    bound = set()
    populated = set()
    for spec in plan.get("tables", []):
        keys = set(spec["tokens"])
        candidates = [(table, row) for table in doc.tables for row in table.rows
                      if keys <= {key for cell in row.cells for p in paragraphs(cell) for key in TOKEN.findall(p.text)}]
        if not keys or len(candidates) != 1:
            raise ValueError("Repeated-row tokens must identify one template row: " + ", ".join(sorted(keys)))
        table, prototype = candidates[0]
        if prototype._tr in bound:
            raise ValueError("A repeated row cannot be bound twice.")
        bound.add(prototype._tr)
        for values in spec["rows"]:
            element = copy.deepcopy(prototype._tr)
            prototype._tr.addprevious(element)
            row = next(row for row in table.rows if row._tr is element)
            for cell in row.cells:
                for p in paragraphs(cell):
                    substitute(p, {**fields, **values})
                    populated.add(p._p)
        prototype._tr.getparent().remove(prototype._tr)
    for p in all_paragraphs(doc):
        if p._p not in populated:
            substitute(p, fields)
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    doc.save(output)
    # Artwork and style definitions are invariants of file-based population.
    with ZipFile(template) as original, ZipFile(output) as saved:
        for name in original.namelist():
            if name.startswith("word/media/") and original.read(name) != saved.read(name):
                raise ValueError("Template artwork changed: " + name)
    return {"saved": Path(output).name, "paragraphs": sum(1 for _ in all_paragraphs(doc)), "tables": len(doc.tables), "unfilledTokens": 0,
            "note": "Check legal content separately and verify actual page count in the editor."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["inspect", "populate"])
    parser.add_argument("--template", required=True)
    parser.add_argument("--data")
    parser.add_argument("--out")
    args = parser.parse_args()
    if args.action == "inspect":
        result = inspect(Document(args.template))
    else:
        if not args.data or not args.out:
            parser.error("populate requires --data and --out")
        result = populate(args.template, json.loads(Path(args.data).read_text()), args.out)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
