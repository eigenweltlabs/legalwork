"""Verify report-register citations against a native saved-job evidence export.

This checks source identity and quotations, not legal conclusions or completeness.
It writes diagnostics to disk and prints only counts, avoiding large chat outputs.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re


def normalise(text):
    return re.sub(r"\s+", " ", text).strip()


def quote_matches(quote, text):
    position = 0
    parts = [part.strip() for part in re.split(r"\.{3}|…", normalise(quote)) if part.strip()]
    if not parts:
        return False
    for part in parts:
        found = normalise(text).find(part, position)
        if found < 0:
            return False
        position = found + len(part)
    return True


def project_file(project, path):
    result = (project / path).resolve()
    if not result.is_relative_to(project):
        raise ValueError("Evidence/register path must stay inside the project.")
    return result


def verify(project, index_path, register_path):
    project = Path(project).resolve()
    index = json.loads(project_file(project, index_path).read_text())
    sources = {}
    for item in index["documents"]:
        pages = {}
        for file in item["evidenceFiles"]:
            data = json.loads(project_file(project, file).read_text())
            if data["document"] != item["document"] or data["sourceHash"] != item["sourceHash"]:
                raise ValueError("Evidence file identity does not match the index.")
            for passage in data["passages"]:
                pages.setdefault(passage["page"], []).append(passage["text"])
        source = project_file(project, item["document"])
        with source.open("rb") as stream:
            actual_hash = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual_hash != item["sourceHash"]:
            raise ValueError("Source changed since the evidence export: " + item["document"])
        sources[item["document"]] = {"hash": actual_hash, "pages": pages}

    register = json.loads(project_file(project, register_path).read_text())
    rows = register.get("findings", []) + register.get("screening_uncertainties", []) + register.get("unresolved_cell_dispositions", [])
    if not rows:
        raise ValueError("Register has no findings or source-backed dispositions to check.")
    checks = []
    for row in rows:
        affected = row.get("affected_files", [])
        citations = row.get("citations") or [{
            "document": row.get("document") or row.get("path") or (affected[0] if affected else None),
            "source_hash": row.get("source_hash"), "page": row.get("page"),
            "quote": row.get("quote") or row.get("supporting_passage"),
        }]
        cited = set()
        for citation in citations:
            document = citation.get("document")
            cited.add(document)
            source = sources.get(document)
            quote = citation.get("quote") or citation.get("supporting_passage")
            page = citation.get("page")
            errors = []
            if not source:
                errors.append("Source is absent from the evidence index")
            else:
                if citation.get("source_hash") != source["hash"]:
                    errors.append("Source hash does not match")
                if not isinstance(page, int) or isinstance(page, bool) or page <= 0 or page not in source["pages"]:
                    errors.append("Cited page is absent")
                elif not isinstance(quote, str) or not any(quote_matches(quote, text) for text in source["pages"][page]):
                    errors.append("Supporting quotation does not occur on the cited page")
            checks.append({"id": row.get("id", row.get("column")), "document": document, "page": page, "errors": errors})
        for document in set(affected) - cited:
            checks.append({"id": row.get("id"), "document": document, "errors": ["Aggregate finding needs a separate citation for each affected source"]})
    failures = [check for check in checks if check["errors"]]
    return {"ok": not failures, "checked": len(checks), "failures": len(failures), "checks": checks,
            "limit": "Literal source support only. Check meaning, coverage, calculations and legal authority separately."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", default=".")
    parser.add_argument("--index", required=True)
    parser.add_argument("--register", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    result = verify(args.project, args.index, args.register)
    output = project_file(Path(args.project).resolve(), args.out)
    if output in [project_file(Path(args.project).resolve(), path) for path in [args.index, args.register]]:
        parser.error("Write diagnostics to a separate output file.")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({"ok": result["ok"], "checked": result["checked"], "failures": result["failures"], "diagnostics": output.name}))
    raise SystemExit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
