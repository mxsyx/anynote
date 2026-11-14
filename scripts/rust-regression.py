#!/usr/bin/env python3
"""RM31 orchestration. A missing, skipped or zero-test stage is never a pass."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent


def stats(values):
    if not values or any(not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in values):
        raise ValueError("timing samples must be nonempty, finite and nonnegative")
    ordered = sorted(values)
    return {"count": len(values), "p50": ordered[math.ceil(len(values) * .50) - 1],
            "p95": ordered[math.ceil(len(values) * .95) - 1],
            "p99": ordered[math.ceil(len(values) * .99) - 1], "max": max(values)}


def budget(values, limit, minimum=20, inclusive=False, percentile="p95"):
    if len(values) < minimum:
        return {"status": "not_measured", "required_samples": minimum, "samples": len(values), "limit_ms": limit}
    summary = stats(values)
    passed = summary[percentile] <= limit if inclusive else summary[percentile] < limit
    return {"status": "passed" if passed else "failed", "limit_ms": limit, "inclusive": inclusive,
            "percentile": percentile, **summary}


def process_sample(pid):
    system = platform.system()
    rows = {}
    if system == "Windows":
        command = (
            "$ErrorActionPreference='Stop'; "
            "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); "
            "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,"
            "WorkingSetSize,HandleCount,ExecutablePath,Name) | ConvertTo-Json -Compress"
        )
        content = subprocess.check_output(["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
                                          encoding="utf-8-sig", timeout=10)
        data = json.loads(content)
        for row in [data] if isinstance(data, dict) else data or []:
            rows[int(row["ProcessId"])] = {
                "pid": int(row["ProcessId"]), "parent": int(row["ParentProcessId"]),
                "rss_bytes": int(row["WorkingSetSize"]) if row.get("WorkingSetSize") is not None else None,
                "open_handles": int(row["HandleCount"]) if row.get("HandleCount") is not None else None,
                "open_fds": None, "executable": row.get("ExecutablePath") or row["Name"],
                "executable_path_available": bool(row.get("ExecutablePath")),
            }
    elif system in ("Darwin", "Linux"):
        content = subprocess.check_output(["ps", "-axo", "pid=,ppid=,rss=,comm="], text=True, timeout=10)
        for line in content.splitlines():
            fields = line.split(None, 3)
            if len(fields) == 4:
                p, parent, rss = map(int, fields[:3])
                rows[p] = {"pid": p, "parent": parent, "rss_bytes": rss * 1024,
                           "open_fds": None, "open_handles": None, "executable": fields[3]}
    else:
        return {"status": "unsupported", "reason": f"process collector unavailable for {system}"}
    if pid not in rows:
        return {"status": "unavailable", "reason": "root process exited before sampling", "processes": []}
    selected = {pid}
    while True:
        expanded = selected | {p for p, row in rows.items() if row["parent"] in selected}
        if expanded == selected:
            break
        selected = expanded
    processes = []
    for p in sorted(selected & rows.keys()):
        row = rows[p]
        handles = None
        if system == "Linux":
            try:
                handles = len(list(Path(f"/proc/{p}/fd").iterdir()))
            except OSError:
                pass
        elif system == "Darwin" and shutil.which("lsof"):
            result = subprocess.run(["lsof", "-a", "-p", str(p), "-Ff"], capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                handles = sum(bool(re.fullmatch(r"f\d+.*", line)) for line in result.stdout.splitlines())
        row["open_fds"] = handles
        processes.append(row)
    return {"status": "measured" if all(p["rss_bytes"] is not None for p in processes) else "unavailable",
            "processes": processes,
            "rss_bytes": sum(p["rss_bytes"] for p in processes) if all(p["rss_bytes"] is not None for p in processes) else None,
            "open_fds": sum(p["open_fds"] for p in processes) if processes and all(p["open_fds"] is not None for p in processes) else None,
            "open_handles": sum(p["open_handles"] for p in processes) if all(p["open_handles"] is not None for p in processes) else None,
            "scope": "observed descendants; reparented/system-owned WebView helpers and GPU memory are not attributed"}


def terminate_tree(child):
    if os.name == "posix":
        import signal
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        finally:
            # The leader may exit on SIGTERM while a worker ignores it.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    else:
        subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                       check=True, capture_output=True, timeout=10)
    child.wait(timeout=5)


def execute(name, argv, output, timeout=1800, sample=False, tests=False):
    log = output / f"{name}.log"
    start = time.monotonic()
    result = {"name": name, "command": argv, "log": str(log.relative_to(ROOT)), "resources": []}
    try:
        with log.open("w") as stream:
            child = subprocess.Popen(argv, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                next_sample = 0
                while child.poll() is None:
                    elapsed = time.monotonic() - start
                    if elapsed > timeout:
                        raise subprocess.TimeoutExpired(argv, timeout)
                    if sample and elapsed >= next_sample:
                        try:
                            result["resources"].append({"seconds": elapsed, **process_sample(child.pid)})
                        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
                            result["resources"].append({"seconds": elapsed, "status": "unavailable", "reason": str(error)})
                        next_sample = elapsed + 2
                    time.sleep(.1)
                result["returncode"] = child.returncode
                result["status"] = "passed" if child.returncode == 0 else "failed"
            finally:
                if child.poll() is None:
                    terminate_tree(child)
        if tests:
            content = log.read_text()
            summaries = re.findall(r"test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored", content)
            result["test_counts"] = {key: sum(int(row[ix]) for row in summaries) for ix, key in enumerate(("passed", "failed", "ignored"))}
            result["aborted_processes"] = re.findall(r"process didn't exit successfully: (.+)", content)
            result["test_counts"]["aborted_processes"] = len(result["aborted_processes"])
            result["passed_tests"] = re.findall(r"^test (.+) \.\.\. ok$", content, re.M)
            if not summaries or result["test_counts"]["passed"] == 0 or result["test_counts"]["failed"] or result["aborted_processes"]:
                result["status"] = "failed"
    except (OSError, subprocess.SubprocessError) as error:
        result.update(status="failed", error=str(error))
    result["seconds"] = time.monotonic() - start
    return result


def evaluate_native(reports):
    samples = {}
    for report in reports:
        for name, values in report["samples"].items():
            samples.setdefault(name, []).extend(values)
    result = {"save_commit": budget(samples.get("save_ack_ms", []), 150),
              "search": budget(samples.get("search_ipc_ms", []), 500),
              "backlinks": budget(samples.get("backlinks_ipc_ms", []), 500)}
    for name, metric, limit, minimum, inclusive, percentile in (
        ("startup", "startup_draw_ms", 3000, 5, False, "p95"),
        ("open", "open_draw_ms", 300, 20, False, "p95"),
        ("input_p95", "input_draw_ms", 50, 100, True, "p95"),
        ("input_p99", "input_draw_ms", 100, 100, True, "p99"),
        ("main_thread_block", "input_draw_ms", 100, 100, True, "max"),
        ("scroll", "scroll_draw_ms", 16.7, 100, True, "p95"),
    ):
        measurement = budget(samples.get(metric, []), limit, minimum, inclusive, percentile)
        result[name] = {"status": "failed" if measurement["status"] == "failed" else "incomplete",
                        "draw_measurement": measurement,
                        "reason": "input draw only; platform refresh and asynchronous event-loop stalls are not observed" if name == "main_thread_block" else "draw completion is not compositor presentation; startup opens editor directly"}
    first_open = samples.get("first_open_draw_ms", [])
    first_measurement = budget(first_open, 300, minimum=5)
    result["first_open"] = {"status": "failed" if first_measurement["status"] == "failed" else "incomplete", "draw_measurement": first_measurement, "cache": "first document in a new process, OS cache retained"}
    for name in ("cold_cache", "first_use_offline", "scroll_frames", "tree_scroll", "backup_ui",
                 "legacy_relative_rss", "total_webview_rss", "closed_handle_task_texture_baseline", "one_hour_load"):
        result[name] = {"status": "not_measured"}
    return result


def resources(samples):
    measured = [s for s in samples if s.get("status") == "measured" and s.get("processes")]
    forbidden = sorted({p["executable"] for s in measured for p in s["processes"]
                        if re.search(r"(^|[/\\])(node|nodejs|electron|qjs|quickjs|gpui-shell)(?:$|[. -])", p["executable"], re.I)})
    result = {"status": "incomplete", "forbidden_processes": forbidden,
              "reason": "descendants only; no old-version baseline, reparented WebView attribution, task/texture or post-close OS handle proof"}
    if forbidden:
        result["status"] = "failed"
    if len(measured) >= 10:
        width = max(1, len(measured) // 5)
        first = stats([s["rss_bytes"] for s in measured[:width]])["p50"]
        last = stats([s["rss_bytes"] for s in measured[-width:]])["p50"]
        allowed = max(first * .1, 32 * 1024 * 1024)
        result.update(first_rss_bytes=first, last_rss_bytes=last, peak_rss_bytes=max(s["rss_bytes"] for s in measured), growth_bytes=last-first, allowed_growth_bytes=allowed,
                      duration_seconds=measured[-1]["seconds"]-measured[0]["seconds"])
        # Whole-run growth includes first use; it detects a failure candidate, not a steady-state pass.
        result["growth_review_required"] = last - first > allowed
    return result


def executable_path(directory, name):
    return directory / (name + (".exe" if platform.system() == "Windows" else ""))


def probe_report(path, stage):
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            raise ValueError("probe report must be an object")
        if data.get("failure") or data.get("shutdown_error"):
            raise ValueError(f"probe failure: {data.get('failure')}; shutdown: {data.get('shutdown_error')}")
        return data
    except (OSError, ValueError) as error:
        stage.update(status="failed", error=str(error))
        return None


def validate_native_report(data):
    if data.get("schema") != 1:
        raise ValueError("unsupported native report schema")
    for metric, minimum in (("startup_draw_ms", 1), ("first_open_draw_ms", 1),
                            ("open_draw_ms", 20), ("save_ack_ms", 20),
                            ("search_ipc_ms", 20), ("backlinks_ipc_ms", 20),
                            ("input_draw_ms", 100), ("scroll_draw_ms", 100)):
        values = data["samples"][metric]
        stats(values)
        if len(values) < minimum:
            raise ValueError(f"{metric}: expected at least {minimum} samples")
    for direction in ("top", "bottom"):
        if data.get("scroll_traversal", {}).get(direction, {}).get("reached") is not True:
            raise ValueError(f"scroll traversal did not reach {direction}")
    if data.get("load_seconds", 0) > 0:
        draws = data["samples"]["load_draw_ms"]
        acknowledgements = data["samples"]["load_backend_ack_ms"]
        stats(draws)
        stats(acknowledgements)
        if len(draws) != len(acknowledgements):
            raise ValueError("concurrent load lost a backend acknowledgement")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stages", default="tests,boundary", help="comma list: tests,boundary,formats,interop,recovery,native,webview,payload")
    parser.add_argument("--release", action="store_true", help="use optimized binaries for native performance probes")
    parser.add_argument("--load-seconds", type=int, default=60)
    parser.add_argument("--runs", type=int, default=5, help="native process launches; fewer than five cannot pass the startup sample gate")
    parser.add_argument("--fixture", type=Path, help="reuse a completed RM31 seed under tmp; each run still receives a private copy")
    parser.add_argument("--payload", type=Path, help="existing native payload for the payload scan/health stage; does not install it")
    parser.add_argument("--strict", action="store_true", help="exit 2 for incomplete acceptance, even if selected checks pass")
    args = parser.parse_args()
    stages = set(args.stages.split(","))
    if not stages <= {"tests", "boundary", "formats", "interop", "recovery", "native", "webview", "payload"} or args.load_seconds < 0 or args.runs < 1:
        parser.error("invalid stages or duration")
    if ("payload" in stages) != (args.payload is not None):
        parser.error("the payload stage and --payload must be specified together")
    if args.fixture:
        args.fixture = args.fixture.resolve()
        if not args.fixture.is_relative_to(ROOT / "tmp") or not (args.fixture / "fixture.json").is_file():
            parser.error("fixture must be a completed disposable RM31 seed under tmp")
    output = ROOT / "tmp" / "rm31" / (time.strftime("%Y%m%d-%H%M%S") + f"-{os.getpid()}")
    output.mkdir(parents=True)
    report = {"schema": 1, "environment": {"os": platform.platform(), "arch": platform.machine(),
              "python": platform.python_version(), "cpu": platform.processor(), "cache": "os_cache_retained", "build": "release" if args.release else "debug"},
              "stages": [], "acceptance": "incomplete", "unmeasured_platforms": [p for p in ("Darwin", "Windows", "Linux") if p != platform.system()]}
    for command, key in ((["git", "rev-parse", "HEAD"], "commit"), (["git", "status", "--short"], "dirty"), (["rustc", "--version"], "rustc")):
        report["environment"][key] = subprocess.check_output(command, cwd=ROOT, text=True).strip()
    report["environment"]["lock_sha256"] = hashlib.sha256((ROOT / "Cargo.lock").read_bytes()).hexdigest()
    report["environment"]["pdfium_dir"] = os.environ.get("ANYNOTE_PDFIUM_DIR")

    def run(name, argv, **kwargs):
        print(f"RM31 {name}: running", flush=True)
        value = execute(name, argv, output, **kwargs)
        report["stages"].append(value)
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(f"RM31 {name}: {value['status']}", flush=True)
        return value["status"] == "passed"

    if "tests" in stages:
        run("report-tests", [sys.executable, "scripts/test-rust-regression.py"])
        pdfium = Path(os.environ.get("ANYNOTE_PDFIUM_DIR", ""))
        if not pdfium.is_absolute() or not (pdfium / "VERSION").is_file():
            report["stages"].append({"name": "pdfium-preflight", "status": "failed", "resources": [], "error": "Set ANYNOTE_PDFIUM_DIR to the absolute pinned installation; see scripts/install-pdfium.py"})
        else:
            run("workspace", ["cargo", "test", "--locked", "--offline", "--no-fail-fast", "--workspace", "--features", "anynote-desktop/ui-tests", "--", "--test-threads=1"], tests=True)
    if "boundary" in stages:
        run("dependencies", [sys.executable, "scripts/check-rust-workspace.py"])
    if "payload" in stages:
        payload = args.payload.resolve()
        if run("payload", [sys.executable, "scripts/rust-release.py", "verify", str(payload), "--health"], sample=True):
            manifest = payload.with_name(payload.name + ".manifest.json")
            report["payload"] = {"path": str(payload), "manifest_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
                                 "identity": json.loads(manifest.read_text()), "final_candidate": False}
    node_ready = True
    if stages & {"interop", "formats"}:
        node_ready = run("node-preflight", ["node", "-e", "if(Number(process.versions.node.split('.')[0])<24)throw Error('RM31 reference drivers require Node >=24');console.log(process.version)"])
    if "interop" in stages and node_ready:
        run("retained-interop", ["node", "scripts/test-retained.mjs"])
    if "formats" in stages and node_ready:
        if run("legacy-oracle-build", [sys.executable, "scripts/legacy-reference.py", "build"]) and run("format-drivers-build", ["cargo", "build", "--locked", "--offline", "-p", "anynote-storage", "-p", "anynote-services", "--examples"]):
            for name in ("readonly", "write", "transfer", "archive", "local-backup"):
                run(f"format-{name}", [sys.executable, "scripts/legacy-reference.py", "run", f"scripts/rust-{name}-reference.mjs"])
            run("format-import", [sys.executable, "scripts/legacy-reference.py", "run", "scripts/rust-import-interop.mjs"])
    if "recovery" in stages:
        if run("recovery-build", ["cargo", "build", "--locked", "--offline", "-p", "anynote-services", "--example", "local_backup_probe", "--example", "archive_probe"]):
            bundle=output / "portable-bundle"
            if run("recovery-prepare", [sys.executable, "scripts/rust-recovery.py", "prepare", str(bundle)]):
                run("recovery-verify", [sys.executable, "scripts/rust-recovery.py", "verify", str(bundle), "--output", str(output / "portable-restored")])
    if stages & {"native", "webview"}:
        binaries = ROOT / "target" / ("release" if args.release else "debug")
        built = run("native-build", ["cargo", "build", "--locked", "--offline", *(["--release"] if args.release else []), "-p", "anynote-desktop", "--features", "ui-tests", "--bin", "anynote-desktop", "--example", "regression_probe", "--example", "webview_probe"])
        if built:
            report["binary_sha256"] = {name: hashlib.sha256(executable_path(binaries, name).read_bytes()).hexdigest() for name in ("anynote-desktop", "examples/regression_probe", "examples/webview_probe")}
        if built and "native" in stages:
            executable = str(executable_path(binaries, "examples/regression_probe"))
            seed = args.fixture or output / "seed"
            if args.fixture or run("fixture", [executable, "prepare", str(seed)]):
                report["fixture"] = {"path": str(seed), "manifest_sha256": hashlib.sha256((seed / "fixture.json").read_bytes()).hexdigest()}
                native_reports = []
                for ix in range(args.runs):
                    state = output / f"state-{ix}"
                    shutil.copytree(seed, state)
                    result = output / f"native-{ix}.json"
                    if run(f"native-{ix}", [executable, "run", str(state), str(executable_path(binaries, "anynote-desktop")), str(result), str(args.load_seconds if ix == 0 else 0)], timeout=args.load_seconds + 300, sample=True):
                        data = probe_report(result, report["stages"][-1])
                        if data is not None:
                            try:
                                validate_native_report(data)
                                native_reports.append(data)
                            except (ValueError, KeyError, TypeError, AttributeError) as error:
                                report["stages"][-1].update(status="failed", error=f"invalid native samples: {error}")
                report["budgets"] = evaluate_native(native_reports)
        if built and "webview" in stages:
            result = output / "webview.json"
            if run("webview-100", [str(executable_path(binaries, "examples/webview_probe")), str(result), "100"], timeout=900, sample=True):
                data = probe_report(result, report["stages"][-1]) or {}
                if data.get("cycles") != 100 or data.get("requested") != 100 or data.get("failure"):
                    report["stages"][-1].update(status="failed", error="100 successful real engine cycles not proven", evidence=data)
    manifest = json.loads((ROOT / "scripts/rust-regression-invariants.json").read_text())
    passed = {name for stage in report["stages"] for name in stage.get("passed_tests", [])}
    for stage in report["stages"]:
        if stage["resources"]:
            stage["resource_evaluation"] = resources(stage["resources"])
            if stage["resource_evaluation"]["status"] == "failed":
                stage["status"] = "failed"
    report["invariants"] = [{**entry, "executed_tests": [name for name in entry["tests"] if name in passed], "status": "partial" if any(name in passed for name in entry["tests"]) else "not_run"} for entry in manifest]
    failed = any(s["status"] == "failed" for s in report["stages"]) or any(b["status"] == "failed" for b in report.get("budgets", {}).values())
    report["selected_checks"] = "failed" if failed else "passed"
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"{report['selected_checks']}; acceptance incomplete; report: {output / 'report.json'}")
    return 1 if failed else 2 if args.strict else 0


if __name__ == "__main__":
    sys.exit(main())
