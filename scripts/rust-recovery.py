#!/usr/bin/env python3
"""Portable synthetic recovery evidence using the Rust v3 backup/restore driver."""
import argparse
import hashlib
import json
import platform
from pathlib import Path
import shutil
import sqlite3
import subprocess

ROOT = Path(__file__).resolve().parent.parent
TABLES = ("nodes", "notes", "note_revisions", "assets", "resources", "revision_resources",
          "annotations", "extension_data", "capture_receipts", "import_reports", "note_text", "note_links")


def logical(directory, book):
    with sqlite3.connect((directory / "notebook.sqlite").as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert not db.execute("PRAGMA foreign_key_check").fetchall()
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
            digest = row["hash"]
            data = directory / "assets/sha256" / digest[:2] / f"{digest}.bin"
            assert data.stat().st_size == row["size"]
            actual = hashlib.sha256(data.read_bytes()).hexdigest()
            assert actual == digest
            assets[digest] = data.stat().st_size
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
    parser.add_argument("--binary", type=Path, default=ROOT / "target/debug/examples/local_backup_probe")
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
        (bundle / "expected.json").write_text(json.dumps({"schema": 1, "book": book, "source_host": platform.node(), "source_platform": platform.platform(), "logical": expected}, ensure_ascii=False, indent=2))
        # The portable bundle must be sufficient after the original notebook is unavailable.
        shutil.rmtree(work)
        print(f"Prepared synthetic Rust backup: {bundle}")
        return
    if not args.output:
        parser.error("verify requires --output pointing to a new isolated directory")
    output = args.output.resolve()
    if output == bundle or output.is_relative_to(bundle) or bundle.is_relative_to(output):
        parser.error("verification output and bundle must be disjoint")
    output.mkdir(parents=True, exist_ok=False)
    expected = json.loads((bundle / "expected.json").read_text())
    for name in ("source-absent", "staging", "restored"):
        (output / name).mkdir()
    # Verification updates v3 last_full_verified_at; copy so the transported evidence stays immutable.
    shutil.copytree(bundle / "disk", output / "disk")
    request = {"root": str(output / "source-absent"), "disk": str(output / "disk"), "temporary": str(output / "staging"), "id": expected["book"]}
    report = {"source_host": expected["source_host"], "verification_host": platform.node(), "platform": platform.platform(),
              "physical_device_independence": "not_proven", "status": "failed"}
    try:
        report["verification"] = call(args.binary.resolve(), output, {**request, "operation": "verify"})
        assert report["verification"]["status"] == "passed"
        restored = call(args.binary.resolve(), output, {**request, "operation": "restore", "destination": str(output / "restored")})
        assert restored["id"] != expected["book"]
        actual = logical(output / "restored" / restored["id"], restored["id"])
        # Normalize tuples from SQL against the JSON transport representation.
        assert json.loads(json.dumps(actual)) == expected["logical"], "restored rows, resources or search differ"
        report.update(status="passed", restored_id=restored["id"], tables=list(TABLES), assets=len(actual["asset_hashes"]))
    except Exception as error:
        report["error"] = str(error) or type(error).__name__
        raise
    finally:
        (output / "recovery-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Rust restore verified: {output / 'recovery-report.json'}")


if __name__ == "__main__":
    main()
