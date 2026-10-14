import sys
sys.dont_write_bytecode = True
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[1] / "helpers/hearts.py"


def load():
    assert HELPER.exists(), "helpers/hearts.py is missing"
    spec = importlib.util.spec_from_file_location("hearts", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class HeartsTest(unittest.TestCase):
    def test_round_trip_records_once(self):
        hearts = load()
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "sub", "hearts.log")
            self.assertEqual(hearts.record(log, "a.b"), {"kind": "saved"})
            self.assertEqual(Path(log).read_text(), "a.b\n")
            self.assertEqual(hearts.record(log, "a.b"), {"kind": "already"})
            self.assertEqual(Path(log).read_text(), "a.b\n")
            self.assertEqual(hearts.record(log, "c_d-e.f"), {"kind": "saved"})
            self.assertEqual(Path(log).read_text(), "a.b\nc_d-e.f\n")

    def test_rejects_bad_ids(self):
        hearts = load()
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "hearts.log")
            for bad in ("../x", "", "__proto__", "constructor", "a" * 200):
                self.assertEqual(hearts.record(log, bad), {"kind": "failed"})
            self.assertFalse(Path(log).exists())

    def test_tolerates_ragged_file(self):
        hearts = load()
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "hearts.log")
            Path(log).write_text("ok.one\n../x\n\nok.one\n")
            self.assertEqual(hearts.record(log, "ok.two"), {"kind": "saved"})
            lines = Path(log).read_text().split("\n")
            self.assertIn("ok.one", lines)
            self.assertIn("ok.two", lines)
            self.assertEqual(hearts.record(log, "ok.one"), {"kind": "already"})

    def test_cli_prints_one_json_object(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = os.path.join(tmp, "hearts.log")
            run = subprocess.run([sys.executable, str(HELPER), log, "cli.id"],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            self.assertEqual(run.returncode, 0)
            self.assertEqual(json.loads(run.stdout), {"kind": "saved"})
            self.assertEqual(Path(log).read_text(), "cli.id\n")


if __name__ == "__main__":
    unittest.main()
