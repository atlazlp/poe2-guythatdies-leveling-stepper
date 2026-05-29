# PoE2 Campaign Stepper

Local campaign progress tracker for Path of Exile 2, based on a speedrun-style zone guide. Tracks step-by-step objectives through acts, interludes, and into maps.

## Quick start

```bash
cd poe2-guythatdies-leveling-stepper
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python server.py
```

This opens the app in your browser at `http://127.0.0.1:8765/`.

## Usage

### Run mode (default)

- Current zone and all its steps shown in the center; adjacent groups previewed on the sides.
- Click the **left half** of the screen for the previous group; **right half** for the next.
- **Ctrl+← / Ctrl+→** also navigate when the browser tab is focused.
- Does not wrap around at the ends.
- **Reset** (corner) appears when you are not on the first group.
- **Gear icon** opens the editor with Save / Cancel.
- **List icon** toggles list mode (auto-saves when returning to run mode).

### List mode

View and edit zone groupings and steps. Add or remove groups and steps freely.

### Keyboard (global)

While the server is running, **Ctrl+Left** and **Ctrl+Right** navigate groups even when another app (e.g. the game) is focused. On Linux this reads your keyboard via evdev; if hotkeys do not work, add your user to the `input` group and log out/in:

```bash
sudo usermod -aG input $USER
```

## Data

- Default campaign steps: `data/campaign-default.json`
- Your progress (steps + current index): `data/progress.json` (created on first run, gitignored)

Reset to defaults:

```bash
python server.py --reset
```

## Options

```bash
python server.py --no-browser   # start server without opening a tab
python server.py --reset        # reset progress.json to defaults
```

## Install as command (optional)

```bash
pip install -e .
poe2-stepper
```
