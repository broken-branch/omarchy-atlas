#!/bin/sh
# Read-only desktop lifecycle measurement. Prints exactly one JSON object.
set -eu

plugin_id=${1:-io.github.broken-branch.atlas}
exec python3 - "$plugin_id" <<'PYTHON'
import json
import os
from pathlib import Path
import subprocess
import sys


def run(*argv):
    try:
        result = subprocess.run(argv, text=True, capture_output=True, check=False)
        return {"ok": result.returncode == 0, "status": result.returncode,
                "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}
    except FileNotFoundError:
        return {"ok": False, "status": None, "stdout": "", "stderr": f"not found: {argv[0]}"}


def plugin_entry(value, plugin_id):
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    candidates = parsed if isinstance(parsed, list) else parsed.get("plugins", []) if isinstance(parsed, dict) else []
    return next((item for item in candidates if isinstance(item, dict) and item.get("id") == plugin_id), None)


plugin_id = sys.argv[1]
home = Path.home()
clone = home / ".config" / "omarchy" / "plugins" / plugin_id
listing = run("omarchy", "plugin", "list", "--json")
validation = run("omarchy", "plugin", "validate", str(clone))
listeners = run("ss", "-ltnp")
processes = run("ps", "-eo", "pid=,args=")
clients = run("hyprctl", "-j", "clients")
layers = run("hyprctl", "-j", "layers")
ipc = run("qs", "ipc", "-n", "-p", "/usr/share/omarchy/shell", "show")
try:
    hypr_clients = json.loads(clients["stdout"]) if clients["ok"] else []
except json.JSONDecodeError:
    hypr_clients = []
atlas_title_clients = [client for client in hypr_clients if client.get("title") == "Atlas Reader"]
try:
    layer_tree = json.loads(layers["stdout"]) if layers["ok"] else {}
except json.JSONDecodeError:
    layer_tree = {}
popup_layers = []


def collect_popup_layers(value):
    if isinstance(value, dict):
        if value.get("namespace") == "omarchy-keyboard-panel":
            popup_layers.append(value)
        for child in value.values():
            collect_popup_layers(child)
    elif isinstance(value, list):
        for child in value:
            collect_popup_layers(child)


collect_popup_layers(layer_tree)
try:
    shell = json.loads((home / ".config" / "omarchy" / "shell.json").read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    shell = {}
layout = shell.get("bar", {}).get("layout", {}) if isinstance(shell, dict) else {}
bar_widget_placed = any(
    isinstance(entry, dict) and entry.get("id") == plugin_id
    for section in ("left", "center", "right")
    for entry in (layout.get(section, []) if isinstance(layout, dict) else [])
)
ipc_target = []
in_target = False
for line in ipc["stdout"].splitlines():
    stripped = line.strip()
    if stripped.startswith("target "):
        if in_target:
            break
        in_target = stripped == f"target {plugin_id}"
    elif in_target and stripped:
        ipc_target.append(stripped)
result = {
    "probe": "lifecycle",
    "pluginId": plugin_id,
    "installedClone": str(clone),
    "validate": validation,
    "plugin": plugin_entry(listing["stdout"], plugin_id),
    "pluginList": {"ok": listing["ok"], "status": listing["status"], "stderr": listing["stderr"]},
    "listeners": [line for line in listeners["stdout"].splitlines() if "127.0.0.1:4137" in line],
    "listenerQuery": {"ok": listeners["ok"], "status": listeners["status"], "stderr": listeners["stderr"]},
    "serveProcesses": sum("atlas.py serve" in line for line in processes["stdout"].splitlines()),
    "processQuery": {"ok": processes["ok"], "status": processes["status"], "stderr": processes["stderr"]},
    "atlasTitleClients": atlas_title_clients,
    "popupLayers": popup_layers,
    "barWidgetPlaced": bar_widget_placed,
    "ipcTarget": ipc_target,
    "hyprctl": {"ok": clients["ok"], "status": clients["status"], "stderr": clients["stderr"]},
    "state": {
        "configExists": (home / ".config" / "omarchy-atlas" / "config.json").is_file(),
        "cacheExists": (home / ".cache" / "omarchy-atlas" / "index.json").is_file(),
    },
}
print(json.dumps(result, sort_keys=True, separators=(",", ":")))
PYTHON
