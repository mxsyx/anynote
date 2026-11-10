#!/usr/bin/env python3
"""Portable synthetic local-backup and full-archive recovery evidence (RM31/33)."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
import platform
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
TABLES = ("nodes", "notes", "note_revisions", "assets", "resources", "revision_resources",
          "annotations", "extension_data", "capture_receipts", "import_reports", "note_text", "note_links")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inventory(directory):
    files = {}
    for path in sorted(directory.rglob("*")):
        require(not path.is_symlink(), f"symlink in recovery evidence: {path}")
        if path.is_dir():
            continue
        require(path.is_file(), f"non-file in recovery evidence: {path}")
        name = path.relative_to(directory).as_posix()
        if name != "bundle-manifest.json":
            files[name] = {"bytes": path.stat().st_size, "sha256": digest(path)}
    return files


def validate_bundle(bundle, expected_digest=None):
    manifest = bundle / "bundle-manifest.json"
    require(not manifest.is_symlink(), "bundle manifest is a symlink")
    actual_digest = digest(manifest)
    if expected_digest:
        require(actual_digest == expected_digest, "transported manifest digest differs")
    data = json.loads(manifest.read_text())
    require(data.get("schema") == "anynote.recovery.bundle.v1", "unsupported recovery bundle")
    files = inventory(bundle)
    require(files == data.get("files"), "bundle files missing, added or changed")
    require("expected.json" in files and "full.anynote" in files, "incomplete recovery bundle")
    require(any(name.startswith("disk/") for name in files), "missing local backup")
    return actual_digest


def environment(device):
    return {"device": device or platform.node(), "host": platform.node(),
            "platform": platform.platform(), "arch": platform.machine(),
            "utc": datetime.now(timezone.utc).isoformat()}


def archive_logical(expected):
    # Full archives intentionally prune unreferenced assets; local v3 backups preserve them.
    value = json.loads(json.dumps(expected))
    tables = value["tables"]
    roots = {row[key] for table, key in (("resources", "asset_hash"),
             ("revision_resources", "asset_hash"), ("annotations", "target_asset_hash"),
             ("note_text", "asset_hash")) for row in tables[table]}
    tables["assets"] = [row for row in tables["assets"] if row["hash"] in roots]
    value["asset_hashes"] = {key: size for key, size in value["asset_hashes"].items() if key in roots}
    return value


def logical(directory, book):
    with sqlite3.connect((directory / "notebook.sqlite").as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        require(db.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "SQLite integrity failed")
        require(not db.execute("PRAGMA foreign_key_check").fetchall(), "foreign key integrity failed")
        tables = {}
        for table in TABLES:
            rows = [dict(row) for row in db.execute(f'SELECT * FROM "{table}"')]
            for row in rows:
                if table == "note_revisions":
                    row["body"] = row["body"].replace(f"anynote://notebook/{book}/", "anynote://notebook/SELF/")
                if table == "note_links" and row["target_notebook_id"] == book:
                    row["target_notebook_id"] = "SELF"
            tables[table] = sorted(rows, key=lambda row: json.dumps(row, sort_keys=True))
        assets = {}
        for row in tables["assets"]:
            asset_hash = row["hash"]
            data = directory / "assets/sha256" / asset_hash[:2] / f"{asset_hash}.bin"
            require(data.stat().st_size == row["size"], f"asset size differs: {asset_hash}")
            require(digest(data) == asset_hash, f"asset hash differs: {asset_hash}")
            assets[asset_hash] = data.stat().st_size
        # Search is queried from the restored index; a row count alone would miss a broken FTS cut.
        hits = [tuple(row) for row in db.execute("SELECT note_id FROM fts_notes WHERE fts_notes MATCH 'Markdown' ORDER BY note_id")]
        return {"tables": tables, "asset_hashes": assets, "search_hits": hits}


def call(binary, directory, request):
    path = directory / "request.json"
    path.write_text(json.dumps(request))
    result = json.loads(subprocess.check_output([str(binary), str(path)], cwd=ROOT, text=True, timeout=180))
    if "error" in result:
        raise RuntimeError(result)
    return result["ok"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "verify"))
    parser.add_argument("bundle", type=Path)
    parser.add_argument("--output", type=Path, help="new isolated verification directory")
    suffix = ".exe" if os.name == "nt" else ""
    parser.add_argument("--binary", type=Path, default=ROOT / f"target/debug/examples/local_backup_probe{suffix}")
    parser.add_argument("--archive-binary", type=Path, default=ROOT / f"target/debug/examples/archive_probe{suffix}")
    parser.add_argument("--device", help="Operator-assigned device label, never proof of independence")
    parser.add_argument("--expected-manifest-sha256", help="Digest recorded separately on the source device")
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    if args.mode == "prepare":
        bundle.mkdir(parents=True, exist_ok=False)
        work = bundle / "preparation"
        work.mkdir()
        source = work / "source"
        source.mkdir()
        corpus = ROOT / "tests/fixtures/rust-migration/corpus"
        book = json.loads((corpus / "expected.json").read_text())["notebookId"]
        shutil.copytree(corpus / "notebook", source / book)
        expected = logical(source / book, book)
        (bundle / "disk").mkdir()
        (work / "staging").mkdir()
        call(args.binary.resolve(), work, {"root": str(source), "disk": str(bundle / "disk"), "temporary": str(work / "staging"), "id": book, "operation": "backup"})
        call(args.archive_binary.resolve(), work, {"root": str(source), "id": book, "operation": "export", "file": str(bundle / "full.anynote"), "current": False})
        (bundle / "expected.json").write_text(json.dumps({"schema": 2, "book": book,
            "source": environment(args.device), "logical": expected,
            "archive_logical": archive_logical(expected),
            "binaries": {"local": digest(args.binary.resolve()), "archive": digest(args.archive_binary.resolve())},
            "lock_sha256": digest(ROOT / "Cargo.lock")}, ensure_ascii=False, indent=2))
        # The portable bundle must be sufficient after the original notebook is unavailable.
        shutil.rmtree(work)
        manifest = bundle / "bundle-manifest.json"
        manifest.write_text(json.dumps({"schema": "anynote.recovery.bundle.v1", "files": inventory(bundle)}, indent=2) + "\n")
        print(f"Prepared synthetic Rust recovery bundle: {bundle}\nManifest SHA-256: {digest(manifest)}")
        return
    if not args.output:
        parser.error("verify requires --output pointing to a new isolated directory")
    output = args.output.resolve()
    if output == bundle or output.is_relative_to(bundle) or bundle.is_relative_to(output):
        parser.error("verification output and bundle must be disjoint")
    output.mkdir(parents=True, exist_ok=False)
    report = {"schema": "anynote.recovery.report.v2", "verification": environment(args.device),
              "physical_device_independence": "not_proven", "acceptance": "incomplete",
              "physical_faults": "not_tested", "remote_committed": "not_tested", "latest_data_rollback": "not_tested",
              "status": "failed", "checks": {}}
    started = time.monotonic()
    try:
        report["manifest_sha256"] = validate_bundle(bundle, args.expected_manifest_sha256)
        report["manifest_pinned"] = bool(args.expected_manifest_sha256)
        expected = json.loads((bundle / "expected.json").read_text())
        require(expected.get("schema") == 2, "unsupported recovery expectations")
        report["source"] = expected["source"]
        report["source_binaries"] = expected["binaries"]
        report["binaries"] = {"local": digest(args.binary.resolve()), "archive": digest(args.archive_binary.resolve())}
        for name in ("source-absent", "staging", "restored", "archive-restored"):
            (output / name).mkdir()
        # Verification updates v3 last_full_verified_at; never mutate transported evidence.
        shutil.copytree(bundle / "disk", output / "disk")
        request = {"root": str(output / "source-absent"), "disk": str(output / "disk"), "temporary": str(output / "staging"), "id": expected["book"]}
        for name in ("local", "archive"):
            check = {"status": "failed"}
            report["checks"][name] = check
            check_started = time.monotonic()
            try:
                if name == "local":
                    check["verification"] = call(args.binary.resolve(), output, {**request, "operation": "verify"})
                    require(check["verification"]["status"] == "passed", "local backup verification failed")
                    destination = output / "restored"
                    restored = call(args.binary.resolve(), output, {**request, "operation": "restore", "destination": str(destination)})
                    reference = expected["logical"]
                else:
                    destination = output / "archive-restored"
                    restored = call(args.archive_binary.resolve(), output, {"root": str(destination), "operation": "import", "file": str(bundle / "full.anynote")})
                    reference = expected["archive_logical"]
                require(restored["id"] != expected["book"], "restore reused source identity")
                actual = logical(destination / restored["id"], restored["id"])
                require(json.loads(json.dumps(actual)) == reference, "restored rows, resources or search differ")
                check.update(status="passed", restored_id=restored["id"], tables=list(TABLES),
                             rows={key: len(rows) for key, rows in actual["tables"].items()}, assets=len(actual["asset_hashes"]))
            except Exception as error:
                check["error"] = str(error) or type(error).__name__
            finally:
                check["seconds"] = time.monotonic() - check_started
        require(validate_bundle(bundle) == report["manifest_sha256"], "transported evidence changed during verification")
        require(all(check["status"] == "passed" for check in report["checks"].values()), "recovery checks failed")
        report["status"] = "passed"
    except Exception as error:
        report["error"] = str(error) or type(error).__name__
        raise
    finally:
        report["seconds"] = time.monotonic() - started
        (output / "recovery-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Rust restore verified: {output / 'recovery-report.json'}")


if __name__ == "__main__":
    main()
