"""Build-time PDF compatibility and bounded SEC-8 regression checks."""

import io
import json
import subprocess
import sys
import unittest

import pypdf


class PdfTests(unittest.TestCase):
    def test_security_floor(self):
        self.assertGreaterEqual(tuple(map(int, pypdf.__version__.split("."))), (6, 21, 4))

    def test_truncated_xref_is_rejected_without_hanging(self):
        # Upstream GHSA-5849-834g-hvw5 / PR #4289. A subprocess deadline
        # keeps this test safe even if a vulnerable package is reintroduced.
        code = """
import io, resource
resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024,) * 2)
from pypdf import PdfReader
from pypdf.errors import PdfReadError
try:
    PdfReader(io.BytesIO(b'%PDF-1.4\\nstartxref\\n28\\n%%EOF\\nxref\\n1 0\\naaa'))
except PdfReadError as error:
    assert 'Xref parsing stuck' in str(error), str(error)
else:
    raise AssertionError('Malformed xref was accepted')
"""
        result = subprocess.run(
            [sys.executable, "-I", "-c", "import sys; sys.path = " + json.dumps(sys.path) + "\n" + code],
            capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_read_extract_merge_and_password_round_trip(self):
        # A small valid PDF with text, independent of pypdf's own writer.
        stream = b"BT /F1 12 Tf 20 20 Td (SEC-8 valid PDF) Tj ET"
        objects = [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        ]
        data = b"%PDF-1.4\n"
        offsets = []
        for index, obj in enumerate(objects, 1):
            offsets.append(len(data))
            data += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"
        xref = len(data)
        data += b"xref\n0 6\n0000000000 65535 f \n"
        data += b"".join(f"{offset:010} 00000 n \n".encode() for offset in offsets)
        data += f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
        reader = pypdf.PdfReader(io.BytesIO(data))
        self.assertEqual(len(reader.pages), 1)
        self.assertEqual(reader.pages[0].extract_text(), "SEC-8 valid PDF")
        writer = pypdf.PdfWriter()
        writer.append(reader)
        writer.append(reader)
        output = io.BytesIO()
        writer.write(output)
        self.assertEqual(len(pypdf.PdfReader(output).pages), 2)
        # RC4 needs no optional crypto package in the guest; this checks the
        # existing password workflow, not a recommendation for new encryption.
        writer.encrypt("test-password", algorithm="RC4-128")
        protected = io.BytesIO()
        writer.write(protected)
        decrypted = pypdf.PdfReader(protected, password="test-password")
        self.assertEqual(decrypted.pages[1].extract_text(), "SEC-8 valid PDF")


if __name__ == "__main__":
    unittest.main()
