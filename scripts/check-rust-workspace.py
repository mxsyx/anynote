#!/usr/bin/env python3
"""Check the locked Rust dependency boundary without starting a JS runtime."""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
metadata = json.loads(subprocess.check_output(
    ["cargo", "metadata", "--locked", "--offline", "--all-features", "--format-version", "1"], cwd=ROOT
))
# Cargo metadata includes weak optional edges not compiled by cargo tree.
# Use the activated all-target tree to distinguish lockfile candidates from builds.
tree = subprocess.check_output(["cargo", "tree", "--locked", "--offline", "--all-features", "--target", "all", "--prefix", "none", "--format", "{p}"], cwd=ROOT, text=True)
active = {tuple(line.split()[:2]) for line in tree.splitlines()}
packages = {p["id"]: p for p in metadata["packages"] if (p["name"], "v" + p["version"]) in active}
members = {packages[key]["name"]: packages[key] for key in metadata["workspace_members"]}
allowed = {
    "anynote-desktop": {"anynote-core", "anynote-storage", "anynote-services", "anynote-editor"},
    "anynote-core": set(),
    "anynote-storage": {"anynote-core"},
    "anynote-services": {"anynote-core", "anynote-storage"},
    "anynote-editor": {"anynote-core"},
}
errors = []
if set(members) != set(allowed):
    errors.append("workspace must contain exactly the five migration units")
for name, package in members.items():
    internal = {dep["name"] for dep in package["dependencies"] if dep["name"].startswith("anynote-")}
    if internal - allowed.get(name, set()):
        errors.append(f"{name}: invalid internal dependency direction {sorted(internal)}")
    if name in {"anynote-core", "anynote-editor"}:
        external = [dep["name"] for dep in package["dependencies"] if dep["name"].startswith(("gpui", "rusqlite", "reqwest", "tokio", "keyring"))]
        if external:
            errors.append(f"{name}: forbidden platform/service dependencies {external}")
for package in packages.values():
    name = package["name"]
    if name in {"gpui-shell", "rquickjs", "rquickjs-core", "quick-js", "libquickjs-sys", "quickjs-runtime", "rusty_v8", "v8", "deno_core", "nodejs-sys", "boa_engine", "electron"}:
        errors.append(f"forbidden desktop host: {name}")
    if (name == "gpui-pre" or name.startswith("gpui-pre-")) and name != "gpui-pre-reqwest" and package["version"] != "0.3.11":
        errors.append(f"unmatched GPUI version: {name} {package['version']}")
    if name in {"gpui-kit", "gpui-base", "gpui-component", "gpui-kit-assets"} and package["version"] != "0.9.0":
        errors.append(f"unmatched Kit version: {name} {package['version']}")
    if name.startswith("gpui-fast"):
        errors.append("GPUI Fast requires a separate validated backend decision")
if errors:
    sys.exit("\n".join(errors))
inventory = [{"name": p["name"], "version": p["version"], "license": p["license"], "links": p["links"], "source": p["source"]} for p in packages.values()]
inventory.sort(key=lambda p: (p["name"], p["version"]))
output = ROOT / "tmp" / "rm02"
output.mkdir(parents=True, exist_ok=True)
(output / "dependency-inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
print(f"Rust boundary passed: {len(members)} units, {len(packages)} locked packages (all targets/features)")
