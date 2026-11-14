#!/usr/bin/env python3
"""Production DocumentEditor/BoardSession + system WebView + real backend, isolated Xvfb input."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--skip-build", action="store_true")
args = parser.parse_args()
if not args.skip_build:
    subprocess.run(["cargo", "build", "--locked", "-p", "anynote-desktop", "--features", "ui-tests", "--example", "whiteboard_session_probe", "--bin", "anynote-desktop"], cwd=ROOT, check=True)
output = ROOT / "tmp/whiteboard-session" / time.strftime("%Y%m%d-%H%M%S")
output.mkdir(parents=True)
env = os.environ.copy()
xvfb = subprocess.Popen(["Xvfb", "-displayfd", "1", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], stdout=subprocess.PIPE, stderr=(output / "xvfb.log").open("w"))
env["DISPLAY"] = ":" + xvfb.stdout.readline().decode().strip()
env.pop("WAYLAND_DISPLAY", None)
binary = Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "target")) / "debug/examples/whiteboard_session_probe"
process = subprocess.Popen([str(binary), str(output)], env=env, stdout=(output / "stdout.log").open("w"), stderr=(output / "stderr.log").open("w"))
report = {"display": "Xvfb", "engine": "system WebKitGTK", "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "checks": [], "failure": None}
command_id = 0
window = None


def command(action, **values):
    global command_id
    command_id += 1
    pending = output / "command.pending"
    pending.write_text(json.dumps({"id": command_id, "action": action, **values}))
    pending.replace(output / "command.json")
    if action == "quit":
        return
    deadline = time.monotonic() + 35
    path = output / f"response-{command_id}.json"
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"probe exited {process.returncode}")
        if path.exists():
            return json.loads(path.read_text())
        time.sleep(.05)
    raise TimeoutError(f"{action}: response-{command_id}")


def wait(predicate, timeout=35):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = command("status")
        if predicate(state):
            return state
        time.sleep(.15)
    raise TimeoutError(f"state did not settle: {state}")


def check(name, condition):
    if not condition:
        raise AssertionError(name)
    report["checks"].append(name)
    print("PASS", name, flush=True)


def xdo(*args):
    return subprocess.check_output(["xdotool", *map(str, args)], env=env, text=True, timeout=10).strip()


def key(*keys):
    xdo("key", "--clearmodifiers", *keys)
    time.sleep(.35)


def focus():
    xdo("windowfocus", "--sync", window)
    xdo("mousemove", "--window", window, 870, 600, "click", 1)
    time.sleep(.2)


def scene():
    command("copy")
    state = wait(lambda s: s["clipboard"] and s["clipboard"] != "pending")
    return json.loads(state["clipboard"])


def draw():
    focus()
    key("r")
    xdo("mousemove", "--window", window, 390, 280, "mousedown", 1)
    time.sleep(.1)
    for step in range(1, 11):
        xdo("mousemove", "--window", window, 390 + step * 17, 280 + step * 11)
        time.sleep(.02)
    xdo("mouseup", 1)
    time.sleep(.4)

try:
    initial = command("status")
    window = xdo("search", "--onlyvisible", "--name", "^Anynote whiteboard session probe$").splitlines()[-1]
    command("draft")
    command("open")
    opened = wait(lambda s: s["ready"])
    check("open flushes pending document draft", "开前的草稿" in opened["body"] and opened["body"] == opened["source"])
    check("production bundled editor loads", len(scene()["elements"]) == 0)
    draw()
    drawn = scene()
    check("native pointer draws rectangle", len(drawn["elements"]) == 1 and drawn["elements"][0]["width"] > 100)
    key("ctrl+z")
    check("native undo removes drawing", len(scene()["elements"]) == 0)
    key("ctrl+shift+z")
    check("native redo restores drawing", len(scene()["elements"]) == 1)
    command("cancel")
    cancelled = wait(lambda s: not s["editing"])
    check("cancel keeps document revision and no resources", cancelled["revision"] == opened["revision"] and cancelled["resources"] == 0)
    command("open")
    wait(lambda s: s["ready"])
    check("cancelled drawing is absent on reopen", len(scene()["elements"]) == 0)
    command("save")
    empty_saved = wait(lambda s: not s["editing"])
    check("empty board saves with a valid preview", not empty_saved["scene"]["elements"] and empty_saved["resources"] == 2)
    opened = empty_saved
    command("open")
    wait(lambda s: s["ready"])
    draw()
    focus()
    key("t")
    xdo("mousemove", "--window", window, 420, 450, "click", 1)
    xdo("type", "--clearmodifiers", "--delay", 50, "Production WebView text")
    # Save while the textarea is still active: the bridge must commit its final text.
    key("ctrl+s")
    saved = wait(lambda s: not s["editing"])
    check("keyboard save commits active text", any(e.get("text") == "Production WebView text" for e in saved["scene"]["elements"]))
    check("atomic save returns document and preview", saved["revision"] == opened["revision"] + 1 and saved["resources"] == 2 and saved["body"] == saved["source"])
    command("open")
    wait(lambda s: s["ready"])
    reopened = scene()
    check("saved elements reopen through resource service", reopened["elements"] == saved["scene"]["elements"])
    fixture = json.loads((ROOT / "scripts/excalidraw-webview/clipboard-fixture.json").read_text())
    command("clipboard", text=json.dumps(fixture))
    focus()
    key("ctrl+v")
    pasted = scene()
    check("system clipboard imports bound shapes and embedded image", len(pasted["files"]) == 1 and any(e.get("startBinding") for e in pasted["elements"]))
    command("save")
    with_image = wait(lambda s: not s["editing"])
    check("embedded image stored as revision resource", with_image["resources"] == 3 and all("dataURL" not in f and "resourceId" in f for f in with_image["scene"]["files"].values()))
    command("open")
    wait(lambda s: s["ready"])
    hydrated = scene()
    check("reopen hydrates embedded image", all(f["dataURL"].startswith("data:image/png;base64,") for f in hydrated["files"].values()))
    command("save")
    reused = wait(lambda s: not s["editing"])
    check("unchanged image reuses immutable resource", reused["scene"]["files"] == with_image["scene"]["files"])
    command("open")
    wait(lambda s: s["ready"])
    command("conflict")
    newer = command("status")
    draw()
    draft = scene()
    command("save")
    wait(lambda s: s["ready"])
    conflict = command("status")
    check("conflict preserves newer document", conflict["revision"] == newer["revision"] and conflict["body"] == newer["body"])
    check("conflict retains editable draft", scene()["elements"] == draft["elements"])
    command("cancel")
    wait(lambda s: not s["editing"])
    subprocess.run(["import", "-window", window, str(output / "complete.png")], env=env, check=True)
    command("quit")
    process.wait(timeout=15)
    check("native WebView and backend exit cleanly", process.returncode == 0)
except Exception as error:
    report["failure"] = repr(error)
    if window and process.poll() is None:
        subprocess.run(["import", "-window", window, str(output / "failure.png")], env=env, timeout=10, check=False)
    raise
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=10)
    xvfb.terminate()
    xvfb.wait(timeout=10)
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(output, flush=True)
