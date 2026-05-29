#!/usr/bin/env python3
"""PoE2 campaign stepper — local server, WebSocket sync, and keyboard shortcuts."""

from __future__ import annotations

import argparse
import asyncio
import glob
import json
import sys
import threading
import webbrowser
from pathlib import Path

from aiohttp import web

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
DATA_DIR = ROOT / "data"
DEFAULT_DATA = DATA_DIR / "campaign-default.json"
PROGRESS_FILE = DATA_DIR / "progress.json"

HOST = "127.0.0.1"
PORT = 8765

ws_clients: set[web.WebSocketResponse] = set()


def load_progress() -> dict:
    if PROGRESS_FILE.exists():
        with PROGRESS_FILE.open(encoding="utf-8") as f:
            return json.load(f)
    with DEFAULT_DATA.open(encoding="utf-8") as f:
        data = json.load(f)
    progress = {"groups": data["groups"], "currentGroupIndex": 0}
    save_progress(progress)
    return progress


def save_progress(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with PROGRESS_FILE.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def group_index_from_progress(progress: dict) -> int:
    groups = progress.get("groups", [])
    if not groups:
        return 0
    if "currentGroupIndex" in progress:
        idx = progress["currentGroupIndex"]
        return max(0, min(idx, len(groups) - 1))
    step_index = progress.get("currentStepIndex", 0)
    count = 0
    for i, group in enumerate(groups):
        count += len(group.get("steps", []))
        if step_index < count:
            return i
    return max(0, len(groups) - 1)


async def broadcast(msg: dict) -> None:
    if not ws_clients:
        return
    payload = json.dumps(msg)
    dead: list[web.WebSocketResponse] = []
    for client in ws_clients:
        try:
            await client.send_str(payload)
        except ConnectionResetError:
            dead.append(client)
    for client in dead:
        ws_clients.discard(client)


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    ws_clients.add(ws)

    progress = load_progress()
    await ws.send_str(
        json.dumps({
            "type": "state",
            "currentGroupIndex": group_index_from_progress(progress),
        })
    )

    try:
        async for msg in ws:
            if msg.type != web.WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            if data.get("type") == "nav":
                await broadcast(data)
            elif data.get("type") == "state":
                progress = load_progress()
                progress["currentGroupIndex"] = data.get("currentGroupIndex", 0)
                save_progress(progress)
                await broadcast(data)
    finally:
        ws_clients.discard(ws)

    return ws


async def api_progress_get(_request: web.Request) -> web.Response:
    return web.json_response(load_progress())


async def api_progress_post(request: web.Request) -> web.Response:
    data = await request.json()
    save_progress(data)
    return web.json_response({"ok": True})


async def static_handler(request: web.Request) -> web.Response:
    rel = request.match_info.get("path", "index.html")
    if rel == "" or rel.endswith("/"):
        rel = "index.html"
    file_path = (WEB_DIR / rel).resolve()
    if not str(file_path).startswith(str(WEB_DIR.resolve())):
        raise web.HTTPForbidden()
    if not file_path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(file_path)


def make_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/progress", api_progress_get)
    app.router.add_post("/api/progress", api_progress_post)
    app.router.add_get("/", static_handler)
    app.router.add_get("/{path:.*}", static_handler)
    return app


async def navigate_group(direction: str) -> None:
    progress = load_progress()
    groups = progress.get("groups", [])
    if not groups:
        return

    idx = group_index_from_progress(progress)
    delta = 1 if direction == "next" else -1
    new_idx = max(0, min(idx + delta, len(groups) - 1))
    if new_idx == idx:
        return

    progress["currentGroupIndex"] = new_idx
    save_progress(progress)
    await broadcast({"type": "state", "currentGroupIndex": new_idx})


def schedule_navigate(loop: asyncio.AbstractEventLoop, direction: str) -> None:
    asyncio.run_coroutine_threadsafe(navigate_group(direction), loop)


def start_evdev_keyboard_listener(loop: asyncio.AbstractEventLoop) -> bool:
    if sys.platform != "linux":
        return False

    try:
        from evdev import InputDevice, ecodes, list_devices
    except ImportError:
        return False

    ctrl_keys = {ecodes.KEY_LEFTCTRL, ecodes.KEY_RIGHTCTRL}
    paths = list_devices()
    if not paths:
        paths = sorted(glob.glob("/dev/input/event*"))

    keyboards: list[InputDevice] = []
    denied = 0
    for path in paths:
        try:
            dev = InputDevice(path)
            caps = dev.capabilities().get(ecodes.EV_KEY, [])
            if ecodes.KEY_A in caps and ecodes.KEY_LEFTCTRL in caps:
                keyboards.append(dev)
        except PermissionError:
            denied += 1
        except OSError:
            continue

    if not keyboards:
        if denied:
            print(
                "Global hotkeys need read access to /dev/input — "
                "run: sudo usermod -aG input $USER  (then log out and back in)",
                file=sys.stderr,
            )
        return False

    def listen(dev: InputDevice) -> None:
        ctrl_held = False
        try:
            for event in dev.read_loop():
                if event.type != ecodes.EV_KEY:
                    continue
                if event.code in ctrl_keys:
                    ctrl_held = event.value != 0
                    continue
                if not ctrl_held or event.value != 1:
                    continue
                if event.code == ecodes.KEY_LEFT:
                    schedule_navigate(loop, "prev")
                elif event.code == ecodes.KEY_RIGHT:
                    schedule_navigate(loop, "next")
        except OSError:
            pass

    for dev in keyboards:
        thread = threading.Thread(target=listen, args=(dev,), daemon=True)
        thread.start()

    names = ", ".join(dev.name for dev in keyboards)
    print(f"Global hotkeys via evdev: {names}")
    return True


def start_keyboard_listener(loop: asyncio.AbstractEventLoop) -> None:
    if start_evdev_keyboard_listener(loop):
        return

    try:
        from pynput import keyboard
    except ImportError:
        print("Global hotkeys unavailable — install evdev (Linux) or pynput", file=sys.stderr)
        return

    ctrl_held = False

    def on_press(key) -> None:
        nonlocal ctrl_held
        if key in (keyboard.Key.ctrl_l, keyboard.Key.ctrl_r):
            ctrl_held = True
            return
        if not ctrl_held:
            return
        if key == keyboard.Key.left:
            schedule_navigate(loop, "prev")
        elif key == keyboard.Key.right:
            schedule_navigate(loop, "next")

    def on_release(key) -> None:
        nonlocal ctrl_held
        if key in (keyboard.Key.ctrl_l, keyboard.Key.ctrl_r):
            ctrl_held = False

    listener = keyboard.Listener(on_press=on_press, on_release=on_release)
    listener.daemon = True
    listener.start()
    print("Global hotkeys via pynput (may not work on Wayland without focus)")


async def main(open_browser: bool = True) -> None:
    loop = asyncio.get_running_loop()
    start_keyboard_listener(loop)

    app = make_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, HOST, PORT)
    await site.start()

    url = f"http://{HOST}:{PORT}/"
    print(f"PoE2 Campaign Stepper running at {url}")
    print("Ctrl+← / Ctrl+→ to navigate groups")

    if open_browser:
        webbrowser.open(url)

    try:
        await asyncio.Future()
    finally:
        await runner.cleanup()


def reset_progress() -> None:
    if PROGRESS_FILE.exists():
        PROGRESS_FILE.unlink()
    progress = load_progress()
    progress["currentGroupIndex"] = 0
    save_progress(progress)
    print("Progress reset to defaults.")


def main_cli() -> None:
    try:
        asyncio.run(main(open_browser=True))
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="PoE2 Campaign Stepper")
    parser.add_argument("--no-browser", action="store_true", help="Do not open browser")
    parser.add_argument("--reset", action="store_true", help="Reset progress to defaults")
    args = parser.parse_args()

    if args.reset:
        reset_progress()
        sys.exit(0)

    try:
        asyncio.run(main(open_browser=not args.no_browser))
    except KeyboardInterrupt:
        print("\nStopped.")
