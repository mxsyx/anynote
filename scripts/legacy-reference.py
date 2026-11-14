#!/usr/bin/env python3
"""Run frozen comparison tools outside the active workspace dependency graph."""
import argparse
import io
import os
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
REVISION = "1aebadd57016ebfaf2e3864bad281f617f921369"
REFERENCE = ROOT / "tmp" / "legacy-reference" / REVISION


def prepare():
    marker = REFERENCE / ".reference-ready"
    if not marker.exists():
        if REFERENCE.exists():
            raise RuntimeError(f"Incomplete reference directory; inspect or remove it before retrying: {REFERENCE}")
        archive = subprocess.check_output(["git", "archive", REVISION], cwd=ROOT)
        REFERENCE.mkdir(parents=True)
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            source.extractall(REFERENCE, filter="data")
        marker.write_text(REVISION + "\n")
    print(f"Frozen reference: {REFERENCE}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("action", choices=["prepare", "install", "build", "run"])
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    prepare()
    env = {**os.environ, "HUSKY": "0"}
    env["ANYNOTE_LEGACY_READER"] = str(REFERENCE / "scripts/rust-migration-legacy-read.mjs")
    if args.action == "install":
        command = ["pnpm", "install", "--frozen-lockfile"]
    elif args.action == "build":
        command = ["pnpm", "run", "build:backend"]
    elif args.action == "run":
        if not args.arguments:
            parser.error("run requires a script path and optional arguments")
        script = (REFERENCE / args.arguments[0]).resolve()
        if not script.is_relative_to(REFERENCE / "scripts") or script.suffix != ".mjs" or not script.is_file():
            parser.error("expected a frozen scripts/*.mjs entry")
        # Readers and nested drivers run in the reference tree, but probes must
        # exercise the current Rust candidate rather than frozen Rust sources.
        target = REFERENCE / "target"
        candidate = Path(env.get("CARGO_TARGET_DIR", ROOT / "target")).resolve()
        if target.is_symlink():
            if target.resolve() != candidate:
                raise RuntimeError("Reference target points at a different candidate")
        elif target.exists():
            raise RuntimeError("Reference target must not contain frozen Rust binaries")
        else:
            target.symlink_to(candidate, target_is_directory=True)
        arguments = args.arguments[1:]
        if "--state" in arguments:
            index = arguments.index("--state") + 1
            if index >= len(arguments):
                parser.error("--state requires a path")
            arguments[index] = str(Path(arguments[index]).resolve())
        options = [f"--env-file={args.env_file.resolve()}"] if args.env_file else []
        command = ["node", *options, str(script), *arguments]
    else:
        return 0
    return subprocess.call(command, cwd=REFERENCE, env=env)


if __name__ == "__main__":
    raise SystemExit(main())
