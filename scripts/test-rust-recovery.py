#!/usr/bin/env python3
"""Recovery evidence must fail closed before invoking native restore."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("recovery", Path(__file__).with_name("rust-recovery.py"))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoveryEvidence(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bundle = self.root / "bundle"
        (self.bundle / "disk").mkdir(parents=True)
        (self.bundle / "disk/backup").write_bytes(b"backup")
        (self.bundle / "full.anynote").write_bytes(b"archive")
        (self.bundle / "expected.json").write_text("{}")
        self.manifest = self.bundle / "bundle-manifest.json"
        self.seal()

    def seal(self):
        self.manifest.write_text(json.dumps({"schema": "anynote.recovery.bundle.v1", "files": recovery.inventory(self.bundle)}))

    def test_missing_added_changed_files_and_wrong_pin_rejected(self):
        pin = recovery.digest(self.manifest)
        self.assertEqual(recovery.validate_bundle(self.bundle, pin), pin)
        with self.assertRaises(ValueError):
            recovery.validate_bundle(self.bundle, "0" * 64)
        archive = self.bundle / "full.anynote"
        archive.write_bytes(b"changed")
        with self.assertRaises(ValueError):
            recovery.validate_bundle(self.bundle)
        archive.write_bytes(b"archive")
        added = self.bundle / "unexpected"
        added.write_bytes(b"extra")
        with self.assertRaises(ValueError):
            recovery.validate_bundle(self.bundle)
        added.unlink()
        archive.unlink()
        with self.assertRaises(ValueError):
            recovery.validate_bundle(self.bundle)

    def test_symlinks_and_manifest_traversal_rejected(self):
        outside = self.root / "outside"
        outside.write_bytes(b"private")
        link = self.bundle / "link"
        link.symlink_to(outside)
        with self.assertRaises(ValueError):
            recovery.validate_bundle(self.bundle)
        link.unlink()
        data = json.loads(self.manifest.read_text())
        data["files"]["../outside"] = {"bytes": 7, "sha256": recovery.digest(outside)}
        self.manifest.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            recovery.validate_bundle(self.bundle)
        self.manifest.unlink()
        self.manifest.symlink_to(outside)
        with self.assertRaises(ValueError):
            recovery.validate_bundle(self.bundle)

    def test_missing_required_payload_rejected_even_with_matching_inventory(self):
        (self.bundle / "full.anynote").unlink()
        self.seal()
        with self.assertRaises(ValueError):
            recovery.validate_bundle(self.bundle)

    def test_archive_prunes_only_unreferenced_assets(self):
        expected = {"tables": {name: [] for name in recovery.TABLES},
                    "asset_hashes": {name: 1 for name in ("current", "history", "annotation", "text", "orphan")}}
        expected["tables"]["assets"] = [{"hash": name} for name in expected["asset_hashes"]]
        for table, key, value in (("resources", "asset_hash", "current"),
                                  ("revision_resources", "asset_hash", "history"),
                                  ("annotations", "target_asset_hash", "annotation"),
                                  ("note_text", "asset_hash", "text")):
            expected["tables"][table] = [{key: value}]
        result = recovery.archive_logical(expected)
        self.assertEqual(set(result["asset_hashes"]), {"current", "history", "annotation", "text"})
        self.assertIn("orphan", expected["asset_hashes"])
        for table in set(recovery.TABLES) - {"assets"}:
            self.assertEqual(result["tables"][table], expected["tables"][table])

    def test_optimized_python_still_reports_corrupt_bundle_without_running_binary(self):
        (self.bundle / "full.anynote").write_bytes(b"changed")
        output = self.root / "result"
        result = subprocess.run([sys.executable, "-O", str(Path(recovery.__file__)), "verify",
                                 str(self.bundle), "--output", str(output), "--binary", str(self.root / "missing")],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        report = json.loads((output / "recovery-report.json").read_text())
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["acceptance"], "incomplete")
        self.assertIn("changed", report["error"])
        self.assertFalse((output / "disk").exists())


if __name__ == "__main__":
    unittest.main()
