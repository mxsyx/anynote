#!/usr/bin/env python3
"""Build each retained target from a source-only copy with other targets absent."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--target", choices=["browser", "worker", "rust", "all"], default="all")
args = parser.parse_args()
output = ROOT / "tmp" / "rm30"
output.mkdir(parents=True, exist_ok=True)
work = Path(tempfile.mkdtemp(prefix="isolated-", dir=output))
report = {"source": str(ROOT), "work": str(work), "targets": {}}


def copy(path, destination):
    source = ROOT / path
    target = destination / path
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, target, ignore=shutil.ignore_patterns("node_modules", "dist", "target", "tmp", ".wrangler", ".dev.vars*"))
    else:
        shutil.copy2(source, target)


def dependencies(owner, destination, owners):
    source = ROOT / owner / "node_modules"
    target = destination / owner / "node_modules"
    target.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / owner / "package.json").read_text())
    declared = {**manifest.get("dependencies", {}), **manifest.get("devDependencies", {})}
    if owner == ".":
        declared = {name: "" for name in ["typescript", "vite", "wrangler"]}
    for name in declared:
        link = target / name
        link.parent.mkdir(parents=True, exist_ok=True)
        if name.startswith("@anynote/"):
            workspace = next((o for o in owners if json.loads((ROOT / o / "package.json").read_text())["name"] == name), None)
            if workspace is None:
                raise RuntimeError(f"Forbidden workspace dependency: {name}")
            link.symlink_to(destination / workspace, target_is_directory=True)
        else:
            installed = source / name
            if not installed.exists():
                raise RuntimeError(f"Install locked dependencies first: {installed}")
            link.symlink_to(installed.resolve(), target_is_directory=True)


def run(target, command, destination, env):
    log = work / f"{target}.log"
    with log.open("a") as stream:
        result = subprocess.run(command, cwd=destination, env=env, stdout=stream, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f"{target} failed; see {log}")


try:
    for target in ([args.target] if args.target != "all" else ["browser", "worker", "rust"]):
        destination = work / target
        destination.mkdir()
        env = dict(os.environ)
        if target == "rust":
            for path in ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "apps/desktop-rust", "crates", "vendor", "scripts/check-rust-workspace.py",
                         "tests/fixtures/rust-migration/config/known-state-mappings.json",
                         "tests/fixtures/rust-migration/inventory/known-plugins.json",
                         "tests/fixtures/builtin/known-manifests.json"]:
                copy(path, destination)
            blocked = destination / "blocked-tools"
            blocked.mkdir()
            for name in ["node", "nodejs", "npm", "pnpm", "npx", "bun", "deno", "electron"]:
                file = blocked / name
                file.write_text("#!/bin/sh\necho 'JS host invoked in Rust isolation' >&2\nexit 99\n")
                file.chmod(0o755)
            env["PATH"] = str(blocked) + os.pathsep + env["PATH"]
            env["CARGO_TARGET_DIR"] = str(destination / "target")
            env.pop("RUSTC_WRAPPER", None)
            env.pop("RUSTC_WORKSPACE_WRAPPER", None)
            run(target, ["cargo", "build", "--locked", "--offline", "-p", "anynote-desktop"], destination, env)
            run(target, ["cargo", "test", "--locked", "--offline", "-p", "anynote-desktop", "--test", "backend"], destination, env)
            run(target, ["python3", "scripts/check-rust-workspace.py"], destination, env)
            assert not (destination / "node_modules").exists()
        else:
            app = "apps/browser-extension" if target == "browser" else "apps/cloudflare-backup"
            packages = ["capture", "protocol", "types"] + (["importer"] if target == "browser" else [])
            owners = [app] + [f"packages/{p}" for p in packages]
            script = "build-browser-extension.mjs" if target == "browser" else "build-worker.mjs"
            for path in owners + ["package.json", "tsconfig.retained.json", "scripts/build-retained.mjs", "scripts/" + script]:
                copy(path, destination)
            for owner in ["."] + owners:
                dependencies(owner, destination, owners)
            # Package-local invocation must work without relying on the caller's cwd.
            run(target, [shutil.which("node"), "../../scripts/" + script], destination / app, env)
            assert not (destination / ".build").exists()
            assert not (destination / "apps/desktop").exists()
            assert not (destination / "apps/desktop-rust").exists()
            assert not (destination / "target").exists()
        report["targets"][target] = "passed"
        print(f"PASS isolated {target}: {destination}", flush=True)
    report["status"] = "passed"
except Exception as error:
    report["status"] = "failed"
    report["error"] = str(error)
    raise
finally:
    (work / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Report: {work / 'report.json'}", flush=True)
