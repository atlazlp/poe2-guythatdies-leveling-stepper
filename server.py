#!/usr/bin/env python3
"""PoE2 campaign stepper — local server, WebSocket sync, and keyboard shortcuts."""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
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
    progress = {"groups": data["groups"], "currentStepIndex": 0}
    save_progress(progress)
    return progress


def save_progress(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with PROGRESS_FILE.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


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
        json.dumps({"type": "state", "currentStepIndex": progress["currentStepIndex"]})
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
                progress["currentStepIndex"] = data.get("currentStepIndex", 0)
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


def start_keyboard_listener(loop: asyncio.AbstractEventLoop) -> None:
    try:
        from pynput import keyboard
    except ImportError:
        print("pynput not installed — keyboard shortcuts disabled", file=sys.stderr)
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
            asyncio.run_coroutine_threadsafe(
                broadcast({"type": "nav", "direction": "prev"}), loop
            )
        elif key == keyboard.Key.right:
            asyncio.run_coroutine_threadsafe(
                broadcast({"type": "nav", "direction": "next"}), loop
            )

    def on_release(key) -> None:
        nonlocal ctrl_held
        if key in (keyboard.Key.ctrl_l, keyboard.Key.ctrl_r):
            ctrl_held = False

    listener = keyboard.Listener(on_press=on_press, on_release=on_release)
    listener.daemon = True
    listener.start()


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
    print("Ctrl+← / Ctrl+→ to navigate steps")

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
    progress["currentStepIndex"] = 0
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
