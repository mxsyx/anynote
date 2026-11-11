#!/usr/bin/env python3
"""RM32 early device batch; automated checks never approve human or final-package gates."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("regression", Path(__file__).with_name("rust-regression.py"))
regression = importlib.util.module_from_spec(spec)
spec.loader.exec_module(regression)
ROOT = regression.ROOT


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def command(args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError(f"{args[0]} exited {result.returncode}: {result.stderr.strip()}")
    return result.stdout.strip()


def source_identity():
    paths = command(["git", "ls-files", "-co", "--exclude-standard", "-z"]).split("\0")
    files = {}
    for name in sorted(set(filter(None, paths))):
        path = ROOT / name
        if path.is_symlink():
            files[name] = "symlink:" + os.readlink(path)
        elif path.is_file():
            files[name] = digest(path)
        else:
            files[name] = "missing"
    return {"commit": command(["git", "rev-parse", "HEAD"]),
            "dirty": command(["git", "status", "--short"]), "files": files,
            "sha256": hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()}


def validate_webview(path, cycles):
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict) or data.get("cycles") != cycles or data.get("requested") != cycles or data.get("failure") is not None or "failure" not in data:
            raise ValueError("requested successful local engine cycles not proven")
        return data
    except (OSError, ValueError) as error:
        raise ValueError(f"invalid WebView evidence: {error}") from error


def pdfium_identity(directory):
    target = {"Darwin": "mac", "Linux": "linux", "Windows": "win"}[platform.system()]
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}[platform.machine().lower()]
    pin = json.loads((ROOT / "apps/desktop-rust/native/pdfium.json").read_text())
    asset = next((a for a in pin["assets"] if a["name"] == f"pdfium-{target}-{arch}.tgz"), None)
    if not directory.is_absolute() or asset is None or not (directory / "VERSION").is_file():
        raise ValueError("Set ANYNOTE_PDFIUM_DIR to an absolute host-platform pinned installation")
    actual = digest(directory / asset["library_path"])
    if actual != asset["library_sha256"]:
        raise ValueError("Pdfium native library differs from the host-platform pin")
    return {"version": (directory / "VERSION").read_text(), "library": asset["library_path"], "sha256": actual}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", required=True, help="Non-sensitive device label; no serial number")
    parser.add_argument("--native", action="store_true", help="Open a real local WebView window (100 cycles)")
    parser.add_argument("--strict", action="store_true", help="Return 2 while device acceptance is incomplete")
    args = parser.parse_args()
    output = ROOT / "tmp/rm32" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + f"-{os.getpid()}")
    output.mkdir(parents=True, exist_ok=False)
    report = {"schema": "anynote.device.batch.v1", "phase": "RM32.1", "device": args.device,
              "started_utc": datetime.now(timezone.utc).isoformat(), "acceptance": "incomplete",
              "environment": {"system": platform.system(), "os": platform.platform(), "arch": platform.machine(),
                              "python": platform.python_version(), "cache": "os_cache_retained", "build": "debug",
                              "session": os.environ.get("XDG_SESSION_TYPE", "not_recorded")},
              "checks": [], "other_platforms": "not_tested",
              "human_checks": "not_tested", "functional_clone_batch": "not_tested",
              "final_candidate_batch": "not_tested"}

    def save():
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

    def run(name, argv, **kwargs):
        print(f"RM32 {name}: running", flush=True)
        result = regression.execute(name, argv, output, **kwargs)
        report["checks"].append(result)
        save()
        print(f"RM32 {name}: {result['status']}", flush=True)
        return result

    save()
    try:
        source = source_identity()
        (output / "source.json").write_text(json.dumps(source, indent=2) + "\n")
        report["source_sha256"] = source["sha256"]
        report["environment"]["rustc"] = command(["rustc", "-vV"])
        report["environment"]["lock_sha256"] = digest(ROOT / "Cargo.lock")
        if platform.system() == "Darwin":
            report["environment"]["hardware"] = command(["sysctl", "hw.model", "hw.memsize", "hw.ncpu", "machdep.cpu.brand_string"])
            device = command(["df", "-P", str(output)]).splitlines()[-1].split()[0]
            run("filesystem", ["diskutil", "info", "-plist", device])
            run("displays", ["system_profiler", "SPDisplaysDataType", "-json"])
        pdfium = Path(os.environ.get("ANYNOTE_PDFIUM_DIR", ""))
        report["pdfium"] = pdfium_identity(pdfium)
        cargo = ["cargo", "test", "--locked", "--offline"]
        stages = [
            ("platform", ["-p", "anynote-desktop", "--test", "platform"]),
            ("sqlite", ["-p", "anynote-storage", "--test", "sqlite_build", "--test", "writes"]),
            ("config-fixtures", ["-p", "anynote-services", "--lib", "config_migration::"]),
            ("backup-migration", ["-p", "anynote-services", "--test", "local_backup", "--test", "migration"]),
            ("prototypes", ["-p", "anynote-desktop", "--features", "ui-tests", "--test", "ui", "--test", "board_ui", "--test", "pdf", "--test", "pdf_io", "--test", "pdf_backend", "--test", "pdf_ui", "--test", "video_ui"]),
        ]
        for name, options in stages:
            run(name, cargo + options + ["--", "--test-threads=1"], tests=True)
        build = run("build", ["cargo", "build", "--locked", "--offline", "-p", "anynote-desktop", "--bin", "anynote-desktop", "--example", "webview_probe", "--message-format=json"])
        if build["status"] == "passed":
            binaries = {}
            for line in (output / "build.log").read_text().splitlines():
                if line.startswith("{"):
                    item = json.loads(line)
                    if item.get("reason") == "compiler-artifact" and item.get("executable"):
                        binaries[item["target"]["name"]] = item["executable"]
            report["binaries"] = {name: {"path": path, "sha256": digest(path)} for name, path in binaries.items()}
            result = run("process", [binaries["anynote-desktop"], "--platform-probe"])
            if result["status"] == "passed":
                data = json.loads((output / "process.log").read_text())
                if not isinstance(data, dict) or data.get("child_process") != "passed" or data.get("window") != "not_tested":
                    result.update(status="failed", error="invalid process probe evidence")
            if args.native:
                result = run("webview", [binaries["webview_probe"], str(output / "webview.json"), "100"], timeout=900)
                if result["status"] == "passed":
                    try:
                        result["evidence"] = validate_webview(output / "webview.json", 100)
                    except ValueError as error:
                        result.update(status="failed", error=str(error))
        report["source_unchanged_during_batch"] = source_identity()["sha256"] == source["sha256"]
        if not report["source_unchanged_during_batch"]:
            report["checks"].append({"name": "source-stability", "status": "failed", "error": "Source changed; rerun for a coherent device batch"})
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        report["checks"].append({"name": "batch", "status": "failed", "error": str(error)})
    failed = not report["checks"] or any(row["status"] != "passed" for row in report["checks"])
    report["selected_checks"] = "failed" if failed else "passed"
    report["finished_utc"] = datetime.now(timezone.utc).isoformat()
    save()
    print(f"{report['selected_checks']}; RM32 acceptance incomplete; {output / 'report.json'}")
    return 1 if failed else 2 if args.strict else 0


if __name__ == "__main__":
    sys.exit(main())
