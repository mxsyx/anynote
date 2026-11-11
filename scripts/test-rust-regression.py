#!/usr/bin/env python3
"""Protect the acceptance report from false positive gates."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

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
        for name in ("/usr/bin/node", r"C:\Program Files\nodejs\node.exe", r"C:\Electron\electron.exe"):
            samples=[{"status":"measured","processes":[{"executable": name}]}]
            self.assertEqual(regression.resources(samples)["status"], "failed")

    def test_windows_working_set_handles_and_descendant_scope(self):
        rows = [
            {"ProcessId": 10, "ParentProcessId": 1, "WorkingSetSize": "1024", "HandleCount": 8,
             "ExecutablePath": r"C:\Anynote\anynote-desktop.exe", "Name": "anynote-desktop.exe"},
            {"ProcessId": 20, "ParentProcessId": 10, "WorkingSetSize": "2048", "HandleCount": 9,
             "ExecutablePath": None, "Name": "anynote-desktop.exe"},
            {"ProcessId": 30, "ParentProcessId": 20, "WorkingSetSize": "4096", "HandleCount": 10,
             "ExecutablePath": None, "Name": "msedgewebview2.exe"},
            {"ProcessId": 40, "ParentProcessId": 1, "WorkingSetSize": "99999", "HandleCount": 100,
             "ExecutablePath": None, "Name": "unrelated.exe"},
        ]
        with patch.object(regression.platform, "system", return_value="Windows"), \
             patch.object(regression.subprocess, "check_output", return_value=json.dumps(rows)):
            sample = regression.process_sample(10)
            self.assertEqual(sample["status"], "measured")
            self.assertEqual(sample["rss_bytes"], 7168)
            self.assertEqual(sample["open_handles"], 27)
            self.assertIsNone(sample["open_fds"])
            self.assertEqual([p["pid"] for p in sample["processes"]], [10, 20, 30])
            self.assertFalse(sample["processes"][1]["executable_path_available"])
            self.assertEqual(regression.process_sample(99)["status"], "unavailable")
            self.assertEqual(regression.executable_path(Path("target"), "examples/probe").name, "probe.exe")
        rows[0]["WorkingSetSize"] = None
        with patch.object(regression.platform, "system", return_value="Windows"), \
             patch.object(regression.subprocess, "check_output", return_value=json.dumps(rows[0])):
            self.assertEqual(regression.process_sample(10)["status"], "unavailable")

    def test_missing_or_invalid_probe_reports_fail(self):
        with tempfile.TemporaryDirectory(dir=regression.ROOT / "tmp") as directory:
            path = Path(directory) / "probe.json"
            for content in (None, "{", "[]", '{"failure":"lost ack"}', '{"shutdown_error":"timeout"}'):
                if content is not None:
                    path.write_text(content)
                stage = {"status": "passed"}
                self.assertIsNone(regression.probe_report(path, stage))
                self.assertEqual(stage["status"], "failed")

    def test_native_samples_and_full_scroll_are_required(self):
        data = {"schema": 1, "samples": {name: [1] * 100 for name in (
            "startup_draw_ms", "first_open_draw_ms", "open_draw_ms", "save_ack_ms",
            "search_ipc_ms", "backlinks_ipc_ms", "input_draw_ms", "scroll_draw_ms")},
            "scroll_traversal": {name: {"reached": True} for name in ("top", "bottom")}}
        regression.validate_native_report(data)
        data["scroll_traversal"]["bottom"]["reached"] = False
        with self.assertRaises(ValueError):
            regression.validate_native_report(data)

        data["scroll_traversal"]["bottom"]["reached"] = True
        for invalid in ([], [1], [float("nan")] * 100):
            data["samples"]["input_draw_ms"] = invalid
            with self.assertRaises(ValueError):
                regression.validate_native_report(data)
        data["samples"]["input_draw_ms"] = [1] * 100
        data["load_seconds"] = 1
        data["samples"].update(load_draw_ms=[1], load_backend_ack_ms=[1, 1])
        with self.assertRaises(ValueError):
            regression.validate_native_report(data)

    @unittest.skipUnless(sys.platform in ("linux", "darwin"), "POSIX collector")
    def test_live_process_sample(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], start_new_session=True)
        try:
            sample = regression.process_sample(child.pid)
            self.assertEqual(sample["status"], "measured")
            self.assertIn(child.pid, [p["pid"] for p in sample["processes"]])
            self.assertGreater(sample["rss_bytes"], 0)
        finally:
            regression.terminate_tree(child)

    @unittest.skipUnless(sys.platform == "linux", "Linux process-state observation")
    def test_timeout_kills_worker_even_when_leader_exits_on_term(self):
        with tempfile.TemporaryDirectory(dir=regression.ROOT / "tmp") as directory:
            output = Path(directory)
            pid_file = output / "worker.pid"
            worker = ("import os,signal,time; from pathlib import Path; "
                      "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                      f"Path({str(pid_file)!r}).write_text(str(os.getpid())); time.sleep(60)")
            parent = f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{worker!r}]); time.sleep(60)"
            result = regression.execute("worker-timeout", [sys.executable, "-c", parent], output, timeout=1)
            self.assertEqual(result["status"], "failed")
            self.assertTrue(pid_file.exists())
            pid = int(pid_file.read_text())
            try:
                for _ in range(100):
                    status = Path(f"/proc/{pid}/stat")
                    if not status.exists() or status.read_text().split(") ", 1)[1][0] == "Z":
                        break
                    time.sleep(.01)
                else:
                    self.fail("timed-out descendant is still running")
            finally:
                try:
                    os.kill(pid, 9)
                except ProcessLookupError:
                    pass

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
