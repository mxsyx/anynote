#!/usr/bin/env python3
"""Linux X11 native-window probe. Run in a disposable Xvfb display; no Node needed."""
import json
import os
import pathlib
import subprocess
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "tmp" / "rm02"
OUTPUT.mkdir(parents=True, exist_ok=True)
BINARY = ROOT / "target" / "debug" / "anynote-desktop"


def run(*args):
    return subprocess.check_output(args, text=True, timeout=10).strip()


def await_value(read, predicate, description):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        value = read()
        if predicate(value):
            return value
        time.sleep(0.05)
    raise AssertionError(description)


with tempfile.TemporaryDirectory(prefix="anynote.rm02.") as state:
    env = dict(os.environ, ANYNOTE_RUST_STATE_DIR=state)
    env.pop("WAYLAND_DISPLAY", None)
    events_path = OUTPUT / "native-x11.jsonl"
    with (OUTPUT / "native-x11.log").open("w") as log:
        process = subprocess.Popen([str(BINARY), "--probe-window", str(events_path)], env=env, stdout=log, stderr=log)
        try:
            def windows():
                result = subprocess.run(["xdotool", "search", "--onlyvisible", "--pid", str(process.pid)], capture_output=True, text=True)
                return result.stdout.splitlines()

            def events():
                if not events_path.exists():
                    return []
                lines = events_path.read_text().splitlines()
                return [json.loads(line) for line in lines if line.endswith("}")]

            def wait_event(name, value=None):
                return await_value(events, lambda rows: any(row["event"] == name and (value is None or row["value"] == value) for row in rows), f"missing {name}: {value}")

            window = await_value(windows, bool, "native window did not open")[0]
            run("xdotool", "windowfocus", "--sync", window)
            wait_event("window")
            run("xdotool", "type", "--clearmodifiers", "Native shell 42")
            wait_event("input", "Native shell 42")
            run("xdotool", "key", "--clearmodifiers", "ctrl+a", "ctrl+c", "BackSpace", "ctrl+v")
            await_value(events, lambda rows: len([r for r in rows if r == {"event": "input", "value": "Native shell 42"}]) >= 2, "clipboard roundtrip failed")
            run("xdotool", "key", "--clearmodifiers", "ctrl+shift+e")
            wait_event("dialog_open")
            time.sleep(0.4)
            run("import", "-window", window, str(OUTPUT / "dialog.png"))
            run("xdotool", "key", "--clearmodifiers", "Escape")
            wait_event("dialog_close")
            run("xdotool", "type", "--clearmodifiers", "!")
            wait_event("input", "Native shell 42!")
            run("xdotool", "key", "--clearmodifiers", "ctrl+shift+t", "ctrl+equal")
            wait_event("zoom", 18.0)
            time.sleep(0.3)
            run("import", "-window", window, str(OUTPUT / "theme-zoom.png"))
            run("xdotool", "key", "--clearmodifiers", "ctrl+shift+t", "ctrl+0")
            wait_event("zoom", 16.0)
            time.sleep(0.3)
            run("import", "-window", window, str(OUTPUT / "shell.png"))
            subprocess.run([str(BINARY)], env=env, check=True, timeout=10)
            wait_event("activated")
            assert len(windows()) == 1, "second instance created another window"
            run("xdotool", "key", "--clearmodifiers", "ctrl+w")
            assert process.wait(timeout=10) == 0
            report = {"os": "linux", "display": "Xvfb/X11", "window": "passed", "keyboard": "passed", "clipboard": "passed", "dialog_escape_focus": "passed", "theme_zoom": "passed", "single_instance_activation": "passed", "close_exit": "passed", "ime": "not_tested", "native_file_picker": "not_tested", "events": events()}
            (OUTPUT / "native-x11-report.json").write_text(json.dumps(report, indent=2) + "\n")
            print("Native X11 probe passed; IME and native file picker require separate verification")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10)
