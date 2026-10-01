"""Run with python3 scripts/test-report-evidence.py; standard library only."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

script = Path(__file__).resolve().parents[1] / "resources/core-opencode/skills/docx-edit/assets/verify-evidence.py"
spec = importlib.util.spec_from_file_location("verify_evidence", script)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class EvidenceChecks(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.project = Path(self.directory.name)
        self.source = self.project / "agreement.pdf"
        self.source.write_bytes(b"original source")
        self.hash = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.save("evidence.json", {"document": "agreement.pdf", "sourceHash": self.hash,
                                   "passages": [{"page": 2, "text": "AsterCloud buys services.\nNo exclusivity applies."}]})
        self.save("index.json", {"documents": [{"document": "agreement.pdf", "sourceHash": self.hash, "evidenceFiles": ["evidence.json"]}]})
        self.citation = {"document": "agreement.pdf", "source_hash": self.hash, "page": 2, "quote": "AsterCloud buys services...No exclusivity applies."}

    def save(self, path, value):
        (self.project / path).write_text(json.dumps(value))

    def run_check(self, row):
        self.save("register.json", {"findings": [row]})
        return helper.verify(self.project, "index.json", "register.json")

    def test_exact_quote_and_ordered_omissions(self):
        self.assertTrue(self.run_check(self.citation)["ok"])

    def test_paraphrase_is_not_a_quotation(self):
        self.assertFalse(self.run_check({**self.citation, "quote": "Operative terms governing current operations."})["ok"])

    def test_wrong_page_and_hash_are_rejected(self):
        self.assertFalse(self.run_check({**self.citation, "page": 1})["ok"])
        self.assertFalse(self.run_check({**self.citation, "source_hash": "wrong"})["ok"])

    def test_a_quote_cannot_reorder_the_original_text(self):
        self.assertFalse(self.run_check({**self.citation, "quote": "No exclusivity applies...AsterCloud buys services."})["ok"])

    def test_each_affected_source_requires_its_own_citation(self):
        self.assertFalse(self.run_check({**self.citation, "affected_files": ["agreement.pdf", "other.pdf"]})["ok"])
        self.assertTrue(self.run_check({"affected_files": ["agreement.pdf"], "citations": [self.citation]})["ok"])

    def test_changed_source_fails_before_citations_are_cleared(self):
        self.source.write_bytes(b"changed source")
        with self.assertRaisesRegex(ValueError, "Source changed"):
            self.run_check(self.citation)

    def test_evidence_identity_and_project_boundary(self):
        self.save("evidence.json", {"document": "other.pdf", "sourceHash": self.hash, "passages": []})
        with self.assertRaisesRegex(ValueError, "identity"):
            self.run_check(self.citation)
        with self.assertRaisesRegex(ValueError, "inside the project"):
            helper.project_file(self.project, "../outside.json")


if __name__ == "__main__":
    unittest.main()
