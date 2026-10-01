"""Build a source-checked Eigenwelt DD report from prose and native review data.

The agent writes fields and findings as JSON. This helper expands source references,
builds the three report tables, checks quotations, and populates the Word template.
Open native decisions stay open; this helper performs no legal inference.
"""
import argparse
import importlib.util
import json
from pathlib import Path


def helper(name, filenames):
    path = next((Path(__file__).with_name(file) for file in filenames
                 if Path(__file__).with_name(file).is_file()), None)
    if path is None:
        raise ValueError("Missing bundled helper: " + name)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def project_file(project, value):
    path = (project / value).resolve()
    if not path.is_relative_to(project):
        raise ValueError("Report inputs and outputs must stay inside the project.")
    return path


def load_packet(project, packet_file):
    packet = json.loads(packet_file.read_text())
    def records(paths):
        return [item for path in paths for item in json.loads(project_file(project, path).read_text())]
    if "sourceFiles" in packet:
        packet["sources"] = records(packet["sourceFiles"])
    for review in packet["reviews"]:
        for key, files in [("rows", "rowFiles"), ("unresolved", "unresolvedFiles")]:
            if files in review:
                review[key] = records(review[files])
    return packet


def assemble(packet, draft):
    if packet.get("packetId") and draft.get("packetId") != packet["packetId"]:
        raise ValueError("The draft does not belong to this pinned review packet. Use its matching packet identity.")
    summary = draft.get("fields", {}).get("executive_summary")
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("Write the buyer-facing executive summary before generating the report.")
    sources = {source["ref"]: source for source in packet["sources"]}
    findings = []
    for index, row in enumerate(draft.get("findings", []), 1):
        citations = []
        requested = list(row.get("citations", []))
        # A shared quotation can cover an entire saved-answer group without the
        # model listing hundreds of IDs or hashes. Every expansion is verified.
        for group in row.get("citationGroups", []):
            review = next((r for r in packet["reviews"] if r["reviewId"] == group["reviewId"]), None)
            if review is None or not isinstance(group.get("values"), list) or not group["values"]:
                raise ValueError("Unknown or empty native answer group.")
            refs = list(dict.fromkeys(source["sourceRef"] for source in review["rows"]
                                     if any(answer["column"] == group["column"] and answer["accepted"]
                                            and answer["value"] in group["values"] for answer in source["answers"])))
            if not refs:
                raise ValueError("The native answer group has no accepted sources.")
            requested.extend({"sourceRef": ref, "page": group["page"], "quote": group["quote"],
                              "clause": group.get("clause", "")} for ref in refs)
        for citation in requested:
            ref = citation["sourceRef"]
            if ref not in sources or not sources[ref]["sourceHash"] or not sources[ref]["evidenceFiles"]:
                raise ValueError("A finding needs original evidence for its source: " + ref)
            source = sources[ref]
            citations.append({"document": source["document"], "source_hash": source["sourceHash"],
                              "page": citation["page"], "quote": citation["quote"],
                              "clause": citation.get("clause", ""), "sourceRef": ref})
        if not citations:
            raise ValueError("Every material finding needs source citations.")
        if row.get("severity") not in ["Critical", "High", "Medium", "Low"]:
            raise ValueError("Use one of the four report severity levels.")
        for key in ["title", "impact", "action", "owner", "timing"]:
            if not isinstance(row.get(key), str) or not row[key].strip():
                raise ValueError("Missing finding text: " + key)
        affected_refs = row.get("affectedSources", [citation["sourceRef"] for citation in citations])
        if any(ref not in sources for ref in affected_refs):
            raise ValueError("Unknown affected source reference.")
        findings.append({**row, "id": row.get("id", "F-" + str(index).zfill(2)), "citations": citations,
                         "affected_files": list(dict.fromkeys(sources[ref]["document"] for ref in affected_refs))})
    fields = {**draft["fields"], **packet.get("measuredFields", {})}
    # Do not allow a draft to alter the measured native scope.
    fields["reviewed_files"] = packet["distinctDocuments"]
    fields["unresolved_files"] = packet["openDocuments"]
    fields["report_status"] = "Draft"
    executive, risks, actions = [], [], []
    shown = sorted(findings, key=lambda finding: ["Critical", "High", "Medium", "Low"].index(finding["severity"]))[:30]
    if len(shown) < len(findings):
        fields["risk_register_note"] = fields.get("risk_register_note", "") + f' The report presents {len(shown)} material themes; the supporting register retains all {len(findings)} findings.'
    for finding in shown:
        refs = []
        for citation in finding["citations"]:
            source = sources[citation["sourceRef"]]
            refs.append(f'{source["title"]} ({Path(source["document"]).name}), p. {citation["page"]}'
                        + (", " + citation["clause"] if citation.get("clause") else ""))
        description = finding["title"] + ": " + finding["impact"]
        executive.append({"sev": finding["severity"], "finding": finding["title"], "action": finding["action"]})
        unique_refs = list(dict.fromkeys(refs))
        reference_text = "; ".join(unique_refs[:3])
        if len(unique_refs) > 3:
            reference_text += f'; and {len(unique_refs) - 3} further sources identified in the supporting register'
        risks.append({"rid": finding["id"], "risk_finding": description,
                      "risk_source": reference_text, "risk_action": finding["action"]})
        actions.append({"aid": finding["id"], "action_timing": finding["timing"],
                        "action_owner": finding["owner"], "action_deliverable": finding["action"]})
    return {"fields": fields, "tables": [
        {"tokens": ["sev", "finding", "action"], "rows": executive},
        {"tokens": ["rid", "risk_finding", "risk_source", "risk_action"], "rows": risks},
        {"tokens": ["aid", "action_timing", "action_owner", "action_deliverable"], "rows": actions},
    ]}, {"findings": findings}, sources


def build(project, packet_path, data_path, template_path, output_path):
    project = Path(project).resolve()
    packet_file, data_file, output = [project_file(project, path) for path in [packet_path, data_path, output_path]]
    template = Path(template_path).resolve()
    if output in [packet_file, data_file, template]:
        raise ValueError("Keep the native packet, prose input and base template intact.")
    if not output.is_relative_to(project / "reports"):
        raise ValueError("Save the report in the project's reports folder.")
    packet = load_packet(project, packet_file)
    draft = json.loads(data_file.read_text())
    plan, register, sources = assemble(packet, draft)
    audit = project_file(project, str((output.parent / (output.stem + "-support")).relative_to(project)))
    protected = {packet_file, data_file, template}
    paths = [project_file(project, str((audit / name).relative_to(project)))
             for name in ["findings.json", "evidence-index.json", "checks.json", "template-content.json", "unresolved.json"]]
    if protected.intersection(paths):
        raise ValueError("Supporting outputs would overwrite a report input.")
    audit.mkdir(parents=True, exist_ok=True)
    register_path, index_path, checks_path, plan_path, unresolved_path = paths
    register_path.write_text(json.dumps(register, ensure_ascii=False, indent=2))
    cited = {citation["document"] for row in register["findings"] for citation in row["citations"]}
    index_path.write_text(json.dumps({"documents": [source for source in sources.values() if source["document"] in cited]}, ensure_ascii=False))
    verifier = helper("verify_evidence", ["verify-evidence.py", "verify_evidence.py"])
    checks = verifier.verify(project, str(index_path.relative_to(project)), str(register_path.relative_to(project))) if cited else {"ok": True, "checked": 0, "failures": 0, "checks": []}
    checks_path.write_text(json.dumps(checks, ensure_ascii=False, indent=2))
    if not checks["ok"]:
        raise ValueError(f'Fix {checks["failures"]} source-support errors in {checks_path.name}; the report was not generated.')
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2))
    unresolved_path.write_text(json.dumps({"openCells": packet["openCells"], "openDocuments": packet["openDocuments"],
                                         "items": [cell for review in packet["reviews"] for cell in review["unresolved"]]}, ensure_ascii=False))
    populate = helper("populate_template", ["populate-template.py", "populate_template.py"])
    result = populate.populate(template, plan, output)
    return {**result, "path": str(output.relative_to(project)), "findings": len(register["findings"]),
            "verifiedCitations": checks["checked"], "openDocuments": packet["openDocuments"],
            "note": "Saved draft; open native decisions remain open. Check saved status and actual page count once in the editor."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", default=".")
    parser.add_argument("--packet", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--template", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.project, args.packet, args.data, args.template, args.out), ensure_ascii=False))


if __name__ == "__main__":
    main()
