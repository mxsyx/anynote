#!/usr/bin/env python3
"""Build isolated assets or exercise the Linux system WebView with native X11 input."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().parent
WORK = ROOT / "tmp/excalidraw-webview"


def run(*args, **kwargs):
    return subprocess.run(list(map(str, args)), check=True, **kwargs)


def prepare():
    WORK.mkdir(parents=True, exist_ok=True)
    for name in ("package.json", "package-lock.json", "index.html", "main.jsx", "vite.config.js"):
        shutil.copy2(SOURCE / name, WORK / name)
    run("npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", ROOT / "tmp/npm-cache", cwd=WORK)
    run("npm", "run", "build", cwd=WORK)
    run("cargo", "build", "--locked", "--offline", "-p", "anynote-desktop", "--example", "excalidraw_webview_probe", cwd=ROOT)


def exercise(xvfb, api_only):
    output = WORK / (time.strftime("run-%Y%m%d-%H%M%S") + ("-xvfb" if xvfb else "-desktop") + ("-api" if api_only else ""))
    output.mkdir(parents=True)
    env = os.environ.copy()
    display_process = None
    if xvfb:
        display_process = subprocess.Popen(["Xvfb", "-displayfd", "1", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], stdout=subprocess.PIPE, stderr=(output / "xvfb.log").open("w"))
        env["DISPLAY"] = ":" + display_process.stdout.readline().decode().strip()
        env.pop("WAYLAND_DISPLAY", None)
    binary = Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "target")) / "debug/examples/excalidraw_webview_probe"
    report = {"platform": "linux", "display": "Xvfb" if xvfb else "desktop X11/XWayland", "excalidraw": "0.18.0", "input_mode": "API only" if api_only else "native X11 input", "checks": [], "failure": None, "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest()}
    command_id = 0
    input_scale = 1
    process = subprocess.Popen([str(binary), str(WORK / "dist"), str(output)], env=env, stdout=(output / "stdout.log").open("w"), stderr=(output / "stderr.log").open("w"))

    def wait_json(name, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"native probe exited: {process.returncode}; see stderr.log")
            path = output / f"{name}.json"
            if path.exists():
                return json.loads(path.read_text())
            time.sleep(0.05)
        raise TimeoutError(f"{name}; see errors.jsonl and stderr.log")

    def command(action, response=True):
        nonlocal command_id
        command_id += 1
        pending = output / "command.pending"
        pending.write_text(json.dumps({"id": command_id, "action": action}))
        pending.replace(output / "command.json")
        if response:
            result = wait_json(f"response-{command_id}")
            if result.get("kind") == "error":
                raise RuntimeError(result)
            return result

    def check(name, condition):
        if not condition:
            raise AssertionError(name)
        report["checks"].append(name)
        print("PASS", name, flush=True)

    def xdo(*args):
        args = list(args)
        for ix, arg in enumerate(args):
            if arg == "mousemove" and args[ix + 1] == "--window":
                args[ix + 3] = round(args[ix + 3] * input_scale)
                args[ix + 4] = round(args[ix + 4] * input_scale)
            elif arg == "windowsize":
                args[ix + 2] = round(args[ix + 2] * input_scale)
                args[ix + 3] = round(args[ix + 3] * input_scale)
        return subprocess.check_output(["xdotool", *map(str, args)], env=env, text=True, timeout=10).strip()

    def key(*keys):
        xdo("key", "--clearmodifiers", *keys)
        time.sleep(0.3)

    def shot(name):
        run("import", "-window", window, output / f"{name}.png", env=env)

    try:
        initial = wait_json("ready-0")
        report["user_agent"] = initial["userAgent"]
        input_scale = initial["viewport"][2]
        report["initial_viewport"] = initial["viewport"]
        check("local assets load in system engine and IPC returns", bool(initial["canvas"]))
        window = xdo("search", "--onlyvisible", "--name", "^Anynote Excalidraw WebView probe$").splitlines()[-1]
        if not api_only:
            if not xvfb:
                xdo("windowactivate", "--sync", window)
                xdo("windowraise", window)
            xdo("windowfocus", "--sync", window)
            xdo("mousemove", "--window", window, 800, 500, "click", 1)
            time.sleep(0.3)
            shot("01-loaded")

            key("r")
            xdo("mousemove", "--window", window, 380, 270, "mousedown", 1)
            time.sleep(0.15)
            for step in range(1, 11):
                xdo("mousemove", "--window", window, 380 + step * 19, 270 + step * 12)
                time.sleep(0.02)
            xdo("mouseup", 1)
            time.sleep(0.4)
            drawn = command("snapshot")
            check("native pointer draws a nonzero rectangle", len(drawn["elements"]) == 1 and drawn["elements"][0]["type"] == "rectangle" and drawn["elements"][0]["width"] > 100)
            key("ctrl+z")
            check("native keyboard undo removes rectangle", len(command("snapshot")["elements"]) == 0)
            key("ctrl+shift+z")
            check("native keyboard redo restores rectangle", len(command("snapshot")["elements"]) == 1)

            key("t")
            xdo("mousemove", "--window", window, 400, 470, "click", 1)
            xdo("type", "--clearmodifiers", "--delay", 60, "Native WebView input")
            key("Escape")
            typed = command("snapshot")
            check("native keyboard creates committed editable text", any(e.get("text") == "Native WebView input" for e in typed["elements"]))
            shot("02-native-input")
            key("v", "ctrl+a", "ctrl+c", "ctrl+v")
            pasted = command("snapshot")
            check("system clipboard copy and paste duplicates selection", len(pasted["elements"]) == 2 * len(typed["elements"]))

            before_zoom = pasted["zoom"]
            xdo("mousemove", "--window", window, 800, 580, "keydown", "Control_L", "click", "--repeat", 3, "--delay", 100, 4, "keyup", "Control_L")
            time.sleep(0.5)
            check("native control-wheel changes canvas zoom", command("snapshot")["zoom"] != before_zoom)
            xdo("windowsize", window, 950, 680)
            time.sleep(0.5)
            resized = command("snapshot")
            check("native window resize updates DOM viewport", resized["viewport"][:2] != initial["viewport"][:2])

        seeded = command("seed")
        check("API fixture includes bound arrow, Chinese text and embedded image", any(e["type"] == "arrow" and e.get("startBinding") and e.get("endBinding") for e in seeded["elements"]) and any("中文" in e.get("text", "") for e in seeded["elements"]) and len(seeded["files"]) == 1)
        command("export")
        check("PNG export returns through IPC to Rust", (output / "preview.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))
        saved = command("save")["scene"]
        check("Rust persists scene and embedded image bytes", json.loads((output / "scene.json").read_text()) == saved and len(saved["files"]) == 1)
        for generation in range(1, 4):
            command("reopen", response=False)
            ready = wait_json(f"ready-{generation}")
            check(f"destroy/recreate {generation}: scene and images restored", ready["elements"] == saved["elements"] and ready["files"] == saved["files"])
        check("native hide", command("hide")["visible"] is False)
        check("native show", command("show")["visible"] is True)
        if not api_only:
            time.sleep(0.3)
            xdo("mousemove", "--window", window, 850, 580, "click", 1)
            key("r")
            xdo("mousemove", "--window", window, 350, 520, "mousedown", 1)
            time.sleep(0.15)
            xdo("mousemove", "--window", window, 500, 600)
            time.sleep(0.15)
            xdo("mouseup", 1)
            time.sleep(0.5)
            check("native editing still works after reopening and showing", len(command("snapshot")["elements"]) == len(saved["elements"]) + 1)
        command("dark")
        shot("03-restored-dark")
        errors = (output / "errors.jsonl").read_text() if (output / "errors.jsonl").exists() else ""
        report["page_errors"] = [json.loads(line) for line in errors.splitlines()]
        expected_font_fallback = "https://esm.sh/@excalidraw/excalidraw@0.18.0/dist/prod/fonts/"
        unexpected = [event for event in report["page_errors"] if not (event.get("kind") == "csp" and event.get("directive") == "font-src" and event.get("blocked", "").startswith(expected_font_fallback))]
        check("no JS errors or unexpected resource failures", not unexpected)
        fonts = command("snapshot")["loadedFonts"]
        report["loaded_fonts"] = fonts
        check("bundled Virgil font loads with CDN fallback blocked", "Virgil" in fonts)
    except Exception as error:
        report["failure"] = str(error)
        print("FAIL", error, flush=True)
        if "window" in locals() and process.poll() is None:
            shot("failure")
    finally:
        if process.poll() is None:
            command("quit", response=False)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        report["exit_code"] = process.returncode
        report["closed"] = (output / "closed.json").exists()
        if process.returncode != 0 or not report["closed"]:
            report["failure"] = report["failure"] or "native lifecycle did not close cleanly"
        if display_process:
            display_process.terminate()
            display_process.wait(timeout=5)
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(output / "report.json", flush=True)
    return 1 if report["failure"] else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("prepare", "run"))
    parser.add_argument("--xvfb", action="store_true", help="isolated display; does not establish physical device acceptance")
    parser.add_argument("--api-only", action="store_true", help="validate rendering and bridge without claiming native input")
    args = parser.parse_args()
    if args.stage == "prepare":
        prepare()
    else:
        raise SystemExit(exercise(args.xvfb, args.api_only))
