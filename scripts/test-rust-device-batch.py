#!/usr/bin/env python3
"""Reject absent, stale and wrong-platform device evidence."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("device", Path(__file__).with_name("rust-device-batch.py"))
device = importlib.util.module_from_spec(spec)
spec.loader.exec_module(device)


class Evidence(unittest.TestCase):
    def test_missing_partial_failed_webview_never_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "webview.json"
            with self.assertRaises(ValueError):
                device.validate_webview(path, 100)
            for data in ({}, [], {"cycles": 100, "requested": 100},
                         {"cycles": 99, "requested": 100, "failure": None},
                         {"cycles": 100, "requested": 100, "failure": "engine error"}):
                path.write_text(json.dumps(data))
                with self.assertRaises(ValueError):
                    device.validate_webview(path, 100)
            path.write_text(json.dumps({"cycles": 100, "requested": 100, "failure": None}))
            self.assertEqual(device.validate_webview(path, 100)["cycles"], 100)



if __name__ == "__main__":
    unittest.main()
