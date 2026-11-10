#!/usr/bin/env python3
"""Protect the acceptance report from false positive gates."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("regression", Path(__file__).with_name("rust-regression.py"))
regression = importlib.util.module_from_spec(spec)
spec.loader.exec_module(regression)


class Reporting(unittest.TestCase):
    def test_budget_boundaries_and_small_samples(self):
        self.assertEqual(regression.budget([150] * 20, 150)["status"], "failed")
        self.assertEqual(regression.budget([50] * 100, 50, inclusive=True)["status"], "passed")
        self.assertEqual(regression.budget([1], 150)["status"], "not_measured")
        self.assertEqual(regression.stats(list(range(1, 101)))["p99"], 99)
        for invalid in ([], [float("nan")], [float("inf")], [-1]):
            with self.assertRaises(ValueError):
                regression.stats(invalid)

    def test_zero_tests_or_nonzero_exit_cannot_pass(self):
        with tempfile.TemporaryDirectory(dir=regression.ROOT / "tmp") as directory:
            output = Path(directory)
            for code in ("print('test result: ok. 0 passed; 0 failed; 0 ignored')", "print('test result: ok. 1 passed; 0 failed; 0 ignored'); raise SystemExit(1)", 'print("test result: ok. 1 passed; 0 failed; 0 ignored\\nprocess didn\'t exit successfully: driver (signal: 5)")'):
                result = regression.execute("empty", [sys.executable, "-c", code], output, tests=True)
                self.assertEqual(result["status"], "failed")
            result = regression.execute("timeout", [sys.executable, "-c", "import time; time.sleep(10)"], output, timeout=.1)
            self.assertEqual(result["status"], "failed")

    def test_draw_and_absent_metrics_never_claim_presentation(self):
        reports = [{"samples": {"startup_draw_ms": [1] * 5, "open_draw_ms": [1] * 20,
                    "input_draw_ms": [1] * 100, "save_ack_ms": [1] * 20, "search_ipc_ms": [1] * 20}}]
        evaluated = regression.evaluate_native(reports)
        self.assertEqual(evaluated["save_commit"]["status"], "passed")
        self.assertEqual(evaluated["input_p95"]["status"], "incomplete")
        self.assertEqual(evaluated["cold_cache"]["status"], "not_measured")
        reports[0]["samples"]["input_draw_ms"] = [101] * 100
        self.assertEqual(regression.evaluate_native(reports)["input_p99"]["status"], "failed")

    def test_observed_forbidden_runtime_fails_and_missing_resources_stay_incomplete(self):
        self.assertEqual(regression.resources([])["status"], "incomplete")
        samples=[{"status":"measured","processes":[{"executable":"/usr/bin/node"}]}]
        self.assertEqual(regression.resources(samples)["status"], "failed")

    def test_inventory_has_all_invariants_and_existing_tests(self):
        entries = json.loads(Path(__file__).with_name("rust-regression-invariants.json").read_text())
        self.assertEqual([e["id"] for e in entries], [f"INV-{i:02}" for i in range(1, 25)])
        sources = "\n".join(p.read_text() for scope in ("apps/desktop-rust", "crates") for p in (regression.ROOT / scope).rglob("*.rs"))
        for entry in entries:
            self.assertTrue(entry["remaining"])
            for test in entry["tests"]:
                self.assertIn("fn " + test.split("::")[-1] + "(", sources)


if __name__ == "__main__":
    unittest.main()
