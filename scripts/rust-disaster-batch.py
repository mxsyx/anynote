#!/usr/bin/env python3
"""RM33 local rehearsal and transport preparation; physical acceptance stays incomplete."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

sys.dont_write_bytecode = True


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


device = module("device", "rust-device-batch.py")
recovery = module("recovery", "rust-recovery.py")
ROOT = device.ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", required=True, help="Non-sensitive operator-assigned device label")
    parser.add_argument("--inspect-path", type=Path, action="append", default=[], help="Existing path for read-only native volume inspection; no backup writes here")
    parser.add_argument("--strict", action="store_true", help="Exit 2 while physical acceptance is incomplete")
    args = parser.parse_args()
    output = ROOT / "tmp/rm33" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + f"-{os.getpid()}")
    output.mkdir(parents=True, exist_ok=False)
    report = {"schema": "anynote.disaster.batch.v1", "environment": recovery.environment(args.device),
              "acceptance": "incomplete", "checks": [], "volumes": [],
              "cache": "os_cache_retained", "build": "debug", "data": "synthetic_small_corpus",
              "physical_device_independence": "not_proven", "physical_faults": "not_tested",
              "remote_committed": "not_tested", "latest_data_rollback": "not_tested", "final_candidate": "not_tested"}

    def save():
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

    def run(name, argv, **kwargs):
        print(f"RM33 {name}: running", flush=True)
        result = device.regression.execute(name, argv, output, **kwargs)
        report["checks"].append(result)
        save()
        print(f"RM33 {name}: {result['status']}", flush=True)
        return result["status"] == "passed"

    save()
    try:
        source = device.source_identity()
        (output / "source.json").write_text(json.dumps(source, indent=2) + "\n")
        report["source_sha256"] = source["sha256"]
        report["lock_sha256"] = device.digest(ROOT / "Cargo.lock")
        report["rustc"] = device.command(["rustc", "-vV"])
        run("evidence-tests", [sys.executable, "scripts/test-rust-recovery.py"])
        if platform.system() == "Darwin":
            run("hardware", ["sysctl", "hw.model", "hw.memsize", "hw.ncpu", "machdep.cpu.brand_string"])
            run("physical-disks", ["diskutil", "list", "-plist", "physical"])
        run("storage-regression", ["cargo", "test", "--locked", "--offline", "-p", "anynote-services",
            "--test", "local_backup", "--test", "archive", "--test", "migration", "--", "--test-threads=1"], tests=True)
        if run("drivers-build", ["cargo", "build", "--locked", "--offline", "-p", "anynote-services",
            "--example", "local_backup_probe", "--example", "archive_probe", "--message-format=json"]):
            binaries = {}
            for line in (output / "drivers-build.log").read_text().splitlines():
                if line.startswith("{"):
                    item = json.loads(line)
                    if item.get("reason") == "compiler-artifact" and item.get("executable"):
                        binaries[item["target"]["name"]] = item["executable"]
            report["binaries"] = {name: {"path": path, "sha256": device.digest(path)} for name, path in binaries.items()}
            for index, path in enumerate([output, *args.inspect_path]):
                path = path.resolve(strict=True)
                facts = recovery.call(Path(binaries["local_backup_probe"]), output, {"operation": "inspect-volume", "path": str(path)})
                report["volumes"].append({"path": str(path), "native": facts, "physical_mapping": "not_proven"})
                if platform.system() == "Darwin":
                    volume_device = device.command(["df", "-P", str(path)]).splitlines()[-1].split()[0]
                    run(f"volume-{index}", ["diskutil", "info", "-plist", volume_device])
            bundle = output / "portable-bundle"
            command = [sys.executable, "scripts/rust-recovery.py"]
            options = ["--binary", binaries["local_backup_probe"], "--archive-binary", binaries["archive_probe"], "--device", args.device]
            if run("recovery-prepare", [*command, "prepare", str(bundle), *options]):
                pin = recovery.validate_bundle(bundle)
                report["bundle_manifest_sha256"] = pin
                report["bundle"] = str(bundle.relative_to(ROOT))
                restored = output / "restored"
                if run("recovery-verify", [*command, "verify", str(bundle), "--output", str(restored), "--expected-manifest-sha256", pin, *options]):
                    evidence = json.loads((restored / "recovery-report.json").read_text())
                    recovery.require(evidence["status"] == "passed" and set(evidence["checks"]) == {"local", "archive"}
                        and all(check["status"] == "passed" for check in evidence["checks"].values()), "missing recovery evidence")
                    report["recovery"] = evidence
        report["source_unchanged_during_batch"] = device.source_identity()["sha256"] == source["sha256"]
        recovery.require(report["source_unchanged_during_batch"], "source changed during batch; rerun required")
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as error:
        report["checks"].append({"name": "batch", "status": "failed", "error": str(error)})
    failed = not report["checks"] or any(row["status"] != "passed" for row in report["checks"])
    report["selected_checks"] = "failed" if failed else "passed"
    report["finished_utc"] = datetime.now(timezone.utc).isoformat()
    save()
    print(f"{report['selected_checks']}; RM33 acceptance incomplete; {output / 'report.json'}")
    return 1 if failed else 2 if args.strict else 0


if __name__ == "__main__":
    sys.exit(main())
