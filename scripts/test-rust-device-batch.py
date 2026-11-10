#!/usr/bin/env python3
"""Reject absent, stale and wrong-platform device evidence."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

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

    def test_native_pin_checks_host_library_and_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pin_path = root / "apps/desktop-rust/native/pdfium.json"
            pin_path.parent.mkdir(parents=True)
            install = root / "installed"
            (install / "bin").mkdir(parents=True)
            (install / "VERSION").write_text("test")
            library = install / "bin/pdfium.dll"
            library.write_bytes(b"test native library")
            pin_path.write_text(json.dumps({"assets": [{"name": "pdfium-win-arm64.tgz", "library_path": "bin/pdfium.dll", "library_sha256": device.digest(library)}]}))
            with patch.object(device, "ROOT", root), patch.object(device.platform, "system", return_value="Windows"), patch.object(device.platform, "machine", return_value="AMD64"):
                with self.assertRaises(ValueError):
                    device.pdfium_identity(install)
            with patch.object(device, "ROOT", root), patch.object(device.platform, "system", return_value="Windows"), patch.object(device.platform, "machine", return_value="ARM64"):
                self.assertEqual(device.pdfium_identity(install)["library"], "bin/pdfium.dll")
                library.write_bytes(b"tampered")
                with self.assertRaises(ValueError):
                    device.pdfium_identity(install)


if __name__ == "__main__":
    unittest.main()
